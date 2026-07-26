/**
 * treespec — Docker integration via dockerode (base image build / tag checks)
 */

import { access, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import Docker from 'dockerode';
import type { ImageConfig } from './config.js';

export type BuildProgressEvent = {
	stream?: string;
	status?: string;
	progress?: string;
	id?: string;
	error?: string;
	errorDetail?: { message?: string };
	[key: string]: unknown;
};

let dockerClient: Docker | null = null;

function getDocker(): Docker {
	if (!dockerClient) {
		dockerClient = new Docker();
	}
	return dockerClient;
}

/** Exposed for tests / advanced callers that need a fresh client. */
export function resetDockerClient(): void {
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

/**
 * Check whether an image tag exists locally.
 */
export async function imageExists(tag: string): Promise<boolean> {
	const docker = getDocker();
	try {
		await docker.getImage(tag).inspect();
		return true;
	} catch (err) {
		const statusCode =
			err && typeof err === 'object' && 'statusCode' in err
				? (err as { statusCode?: number }).statusCode
				: undefined;
		if (statusCode === 404) {
			return false;
		}
		throw formatDockerError(err);
	}
}

async function listContextFiles(contextDir: string): Promise<string[]> {
	const skip = new Set(['.git', 'node_modules', '.treespec-output', 'dist']);
	const files: string[] = [];

	async function walk(absDir: string, rel: string): Promise<void> {
		const entries = await readdir(absDir, { withFileTypes: true });
		for (const entry of entries) {
			if (skip.has(entry.name)) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			const childAbs = join(absDir, entry.name);
			if (entry.isDirectory()) {
				await walk(childAbs, childRel);
			} else if (entry.isFile() || entry.isSymbolicLink()) {
				files.push(childRel);
			}
		}
	}

	await walk(contextDir, '');
	return files;
}

function followProgress(
	docker: Docker,
	stream: NodeJS.ReadableStream,
	onProgress?: (data: BuildProgressEvent) => void,
): Promise<BuildProgressEvent[]> {
	return new Promise((resolve, reject) => {
		docker.modem.followProgress(
			stream,
			(err: Error | null, output: BuildProgressEvent[]) => {
				if (err) {
					reject(err);
					return;
				}
				const failed = output?.find((e) => e.error);
				if (failed?.error) {
					reject(new Error(failed.error));
					return;
				}
				resolve(output ?? []);
			},
			(event: BuildProgressEvent) => {
				onProgress?.(event);
			},
		);
	});
}

/**
 * Build an image from `config.dockerfile` under `contextDir`.
 * Tags with `config.tag`, passes `config.args` as build args.
 * Returns the tag on success.
 */
export async function buildImage(
	config: ImageConfig,
	contextDir: string,
	onProgress?: (data: BuildProgressEvent) => void,
): Promise<string> {
	const dockerfilePath = join(contextDir, config.dockerfile);

	try {
		await access(dockerfilePath);
	} catch {
		throw new Error(`Dockerfile not found: ${dockerfilePath}`);
	}

	const contextStat = await stat(contextDir);
	if (!contextStat.isDirectory()) {
		throw new Error(`Build context is not a directory: ${contextDir}`);
	}

	const docker = getDocker();
	const src = await listContextFiles(contextDir);

	if (!src.includes(config.dockerfile.replace(/\\/g, '/'))) {
		src.push(config.dockerfile.replace(/\\/g, '/'));
	}

	const buildargs: Record<string, string> = {};
	if (config.args) {
		for (const [key, value] of Object.entries(config.args)) {
			buildargs[key] = String(value);
		}
	}

	let stream: NodeJS.ReadableStream;
	try {
		stream = await docker.buildImage(
			{
				context: contextDir,
				src,
			},
			{
				t: config.tag,
				dockerfile: config.dockerfile.replace(/\\/g, '/'),
				buildargs: Object.keys(buildargs).length > 0 ? buildargs : undefined,
			},
		);
	} catch (err) {
		throw formatDockerError(err);
	}

	try {
		await followProgress(docker, stream, onProgress);
	} catch (err) {
		throw formatDockerError(err);
	}

	return config.tag;
}

/**
 * Pull a base image (e.g. alpine, node) if it is not present locally.
 */
export async function pullImageIfMissing(tag: string): Promise<void> {
	if (await imageExists(tag)) {
		return;
	}

	const docker = getDocker();
	let stream: NodeJS.ReadableStream;
	try {
		stream = await docker.pull(tag);
	} catch (err) {
		throw formatDockerError(err);
	}

	try {
		await followProgress(docker, stream);
	} catch (err) {
		throw formatDockerError(err);
	}
}
