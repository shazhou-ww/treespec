/**
 * treespec — Container lifecycle via dockerode (create → start → exec → remove)
 */

import { PassThrough } from 'node:stream';
import Docker from 'dockerode';

export interface ExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	timedOut: boolean;
}

export interface CreateContainerOptions {
	env?: Record<string, string>;
	/**
	 * Absolute path to the specs root directory.
	 * Mounted read-only at `/specs` inside the container.
	 */
	specsDir?: string;
	/**
	 * Path relative to the specs root (the case directory).
	 * Becomes WorkingDir `/specs/<workdir>`.
	 */
	workdir?: string;
}

export interface RunInContainerOptions extends CreateContainerOptions {
	timeout?: number;
}

let dockerClient: Docker | null = null;

function getDocker(): Docker {
	if (!dockerClient) {
		dockerClient = new Docker();
	}
	return dockerClient;
}

/** Exposed for tests / advanced callers that need a fresh client. */
export function resetExecutorDockerClient(): void {
	dockerClient = null;
}

function formatDockerError(err: unknown): Error {
	if (err instanceof Error) {
		const msg = err.message;
		if (
			msg.includes('ENOENT') ||
			msg.includes('ECONNREFUSED') ||
			msg.includes('connect') ||
			msg.includes('docker.sock')
		) {
			return new Error(
				`Docker is not available (${msg}). Is the Docker daemon running?`,
			);
		}
		return err;
	}
	return new Error(String(err));
}

function envToArray(env?: Record<string, string>): string[] | undefined {
	if (!env) return undefined;
	const entries = Object.entries(env);
	if (entries.length === 0) return undefined;
	return entries.map(([k, v]) => `${k}=${v}`);
}

/**
 * Create and start a long-running container from `imageTag`.
 * Returns the container id. Caller must remove it.
 *
 * When `specsDir` is set, mounts it read-only at `/specs` and sets
 * WorkingDir to `/specs/<workdir>` (defaults to `/specs`).
 */
export async function createAndStartContainer(
	imageTag: string,
	options: CreateContainerOptions = {},
): Promise<string> {
	const docker = getDocker();
	const env = options.env;

	const hostConfig: {
		AutoRemove: boolean;
		Binds?: string[];
	} = {
		AutoRemove: false,
	};

	const createOpts: {
		Image: string;
		Cmd: string[];
		Env?: string[];
		AttachStdout: boolean;
		AttachStderr: boolean;
		Tty: boolean;
		WorkingDir?: string;
		HostConfig: typeof hostConfig;
	} = {
		Image: imageTag,
		Cmd: ['sleep', 'infinity'],
		Env: envToArray(env),
		AttachStdout: false,
		AttachStderr: false,
		Tty: false,
		HostConfig: hostConfig,
	};

	if (options.specsDir) {
		hostConfig.Binds = [`${options.specsDir}:/specs:ro`];
		const relative = options.workdir && options.workdir !== '.'
			? options.workdir.replace(/^\/+/, '').replace(/\/+$/, '')
			: '';
		createOpts.WorkingDir = relative ? `/specs/${relative}` : '/specs';
	}

	try {
		const container = await docker.createContainer(createOpts);
		await container.start();
		return container.id;
	} catch (err) {
		throw formatDockerError(err);
	}
}

/**
 * Execute a shell command inside an existing container.
 * On timeout, the container is killed and timedOut is true.
 */
export async function execInContainer(
	containerId: string,
	command: string,
	options: { timeout?: number; env?: Record<string, string> } = {},
): Promise<ExecResult> {
	const docker = getDocker();
	const container = docker.getContainer(containerId);
	const timeoutMs = options.timeout;

	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stdout = '';
	let stderr = '';
	let exitCode = 1;

	try {
		const exec = await container.exec({
			Cmd: ['/bin/sh', '-c', command],
			AttachStdout: true,
			AttachStderr: true,
			Env: envToArray(options.env),
		});

		const stream = await exec.start({ hijack: true, stdin: false });

		const collectPromise = new Promise<void>((resolve, reject) => {
			const stdoutStream = new PassThrough();
			const stderrStream = new PassThrough();
			const stdoutChunks: Buffer[] = [];
			const stderrChunks: Buffer[] = [];

			stdoutStream.on('data', (chunk: Buffer) => {
				stdoutChunks.push(Buffer.from(chunk));
			});
			stderrStream.on('data', (chunk: Buffer) => {
				stderrChunks.push(Buffer.from(chunk));
			});

			docker.modem.demuxStream(stream, stdoutStream, stderrStream);

			stream.on('end', () => {
				stdoutStream.end();
				stderrStream.end();
				stdout = Buffer.concat(stdoutChunks).toString('utf8');
				stderr = Buffer.concat(stderrChunks).toString('utf8');
				resolve();
			});
			stream.on('error', reject);
		});

		const timeoutPromise =
			timeoutMs !== undefined && timeoutMs > 0
				? new Promise<'timeout'>((resolve) => {
						timer = setTimeout(() => resolve('timeout'), timeoutMs);
					})
				: null;

		const winner = timeoutPromise
			? await Promise.race([collectPromise.then(() => 'done' as const), timeoutPromise])
			: await collectPromise.then(() => 'done' as const);

		if (timer) clearTimeout(timer);

		if (winner === 'timeout') {
			timedOut = true;
			try {
				stream.destroy();
			} catch {
				// ignore
			}
			try {
				await container.kill();
			} catch {
				// Container may already be dead.
			}
			// Drain collectPromise to avoid unhandled rejection
			await Promise.race([
				collectPromise.catch(() => undefined),
				new Promise((r) => setTimeout(r, 200)),
			]);
			return {
				stdout: stdout || '',
				stderr: stderr || '',
				exitCode: 124,
				timedOut: true,
			};
		}

		const inspected = await exec.inspect();
		exitCode = inspected.ExitCode ?? 1;
		return { stdout, stderr, exitCode, timedOut: false };
	} catch (err) {
		if (timer) clearTimeout(timer);
		throw formatDockerError(err);
	}
}

/**
 * Force-remove a container (ignore if already gone).
 */
export async function removeContainer(containerId: string): Promise<void> {
	const docker = getDocker();
	try {
		await docker.getContainer(containerId).remove({ force: true });
	} catch (err) {
		const statusCode =
			err && typeof err === 'object' && 'statusCode' in err
				? (err as { statusCode?: number }).statusCode
				: undefined;
		if (statusCode === 404) {
			return;
		}
		throw formatDockerError(err);
	}
}

/**
 * Create container → start → exec command → remove (always).
 */
export async function runInContainer(
	imageTag: string,
	command: string,
	options: RunInContainerOptions = {},
): Promise<ExecResult> {
	let containerId: string | undefined;
	try {
		containerId = await createAndStartContainer(imageTag, {
			env: options.env,
			specsDir: options.specsDir,
			workdir: options.workdir,
		});
		return await execInContainer(containerId, command, {
			timeout: options.timeout,
			env: options.env,
		});
	} finally {
		if (containerId) {
			await removeContainer(containerId);
		}
	}
}
