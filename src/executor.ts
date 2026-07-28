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
	 * Absolute path to the project root on the host.
	 * Mounted read-only at `/app` inside the container.
	 */
	projectDir?: string;
	/**
	 * Path of the spec directory relative to projectDir (e.g. "spec").
	 * Combined with workdir to form the container WorkingDir:
	 *   /app/<specRelative>/<workdir>
	 */
	specRelative?: string;
	/**
	 * Path relative to the specs root (the case directory).
	 * Becomes WorkingDir `/app/<specRelative>/<workdir>`.
	 */
	workdir?: string;
	/**
	 * When true, project is already in the image (baked via COPY).
	 * Skip the bind mount; WorkingDir still resolves to /app/...
	 */
	noMount?: boolean;
	/** Docker network mode (e.g. "host", "bridge"). */
	network?: string;
	/** Extra host entries (same format as docker --add-host). */
	extraHosts?: string[];
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
 * When `projectDir` is set, mounts it read-only at `/app` and sets
 * WorkingDir to `/app/<specRelative>/<workdir>`.
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
		NetworkMode?: string;
		ExtraHosts?: string[];
	} = {
		AutoRemove: false,
	};

	if (options.network) {
		hostConfig.NetworkMode = options.network;
	}
	if (options.extraHosts && options.extraHosts.length > 0) {
		hostConfig.ExtraHosts = options.extraHosts;
	}

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

	const binds: string[] = [];

	// Mount projectDir at /app:ro (skip for noMount / DinD)
	if (!options.noMount && options.projectDir) {
		binds.push(`${options.projectDir}:/app:ro`);
	}

	// WorkingDir: /app/<specRelative>/<workdir>
	const specsRel = options.specRelative
		? options.specRelative.replace(/^\/+/, '').replace(/\/+$/, '')
		: '';
	const casePath = options.workdir && options.workdir !== '.'
		? options.workdir.replace(/^\/+/, '').replace(/\/+$/, '')
		: '';
	const parts = ['/app'];
	if (specsRel) parts.push(specsRel);
	if (casePath) parts.push(casePath);
	createOpts.WorkingDir = parts.join('/');

	// Always mount Docker socket so containers can use Docker-in-Docker
	binds.push('/var/run/docker.sock:/var/run/docker.sock');
	if (binds.length > 0) {
		hostConfig.Binds = binds;
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
	options: { timeout?: number } = {},
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
			projectDir: options.projectDir,
			specRelative: options.specRelative,
			workdir: options.workdir,
		});
		return await execInContainer(containerId, command, {
			timeout: options.timeout,
		});
	} finally {
		if (containerId) {
			await removeContainer(containerId);
		}
	}
}
