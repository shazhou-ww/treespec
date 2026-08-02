/**
 * treespec — Docker integration via dockerode (base image build / tag checks)
 */

import { access, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
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

let dockerdEnsured = false;

/**
 * Ensure dockerd is running. On the host, this is a no-op (dockerd already runs).
 * Inside a DinD container, starts dockerd with fuse-overlayfs if not already running.
 * Called lazily before the first Docker operation (build/create/commit/etc.).
 */
export async function ensureDockerd(): Promise<void> {
	if (dockerdEnsured) return;
	const docker = getDocker();

	// Check if dockerd is already running (host or previously started in-container)
	try {
		await docker.ping();
		dockerdEnsured = true;
		return;
	} catch {
		// Not running — check if dockerd binary exists (i.e., we're in a DinD container)
	}

	try {
		execSync('which dockerd', { stdio: 'ignore' });
	} catch {
		// No dockerd binary — this is the host. Docker should be running.
		throw new Error(
			'Docker is not available. Is the Docker daemon running?',
		);
	}

	// Clean stale runtime state from parent's committed layer
	try {
		execSync('rm -rf /var/run/docker /var/run/docker.pid /var/run/docker.sock', { stdio: 'ignore' });
	} catch { /* ignore */ }

	// Start dockerd with fuse-overlayfs (vfs loses permissions, overlay2 doesn't nest)
	try {
		execSync('dockerd --storage-driver=fuse-overlayfs > /dev/null 2>&1 &', { stdio: 'ignore' });
	} catch { /* ignore — will check below */ }

	// Wait for dockerd to be ready (up to 30s)
	for (let i = 0; i < 60; i++) {
		try {
			await docker.ping();
			dockerdEnsured = true;
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	throw new Error('Docker daemon failed to start within 30 seconds');
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
	if (!config.dockerfile) {
		throw new Error(
			'image.dockerfile is required to build (or pass --image <tag> to use an existing image)',
		);
	}
	if (!config.tag) {
		throw new Error(
			'image.tag is required to build (set name or image.tag in treespec.yaml)',
		);
	}
	const tag = config.tag;
	const dockerfile = config.dockerfile;
	const dockerfilePath = join(contextDir, dockerfile);

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

	if (!src.includes(dockerfile.replace(/\\/g, '/'))) {
		src.push(dockerfile.replace(/\\/g, '/'));
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
				t: tag,
				dockerfile: dockerfile.replace(/\\/g, '/'),
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

	return tag;
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

const EPHEMERAL_REPO = 'treespec/ephemeral';

/**
 * Build an ephemeral image tag from a node path.
 * Uses the last path segment + 8-char hash for uniqueness.
 * e.g. `provider-add/model-add` → `treespec/ephemeral:model-add-a1b2c3d4`
 */
export function ephemeralTagForPath(nodePath: string): string {
	const clean = nodePath.replace(/^\/+|\/+$/g, '');
	const lastSegment = clean.split('/').pop() || 'root';
	const safeSegment = lastSegment === '.' ? 'root' : lastSegment;
	const hash = createHash('sha256').update(clean).digest('hex').slice(0, 8);
	return `${EPHEMERAL_REPO}:${safeSegment}-${hash}`;
}

/**
 * Commit a running container to `imageTag` (repo:tag).
 */
export async function commitContainer(
	containerId: string,
	imageTag: string,
): Promise<string> {
	const docker = getDocker();
	const colon = imageTag.lastIndexOf(':');
	const repo = colon === -1 ? imageTag : imageTag.slice(0, colon);
	const tag = colon === -1 ? 'latest' : imageTag.slice(colon + 1);

	try {
		const container = docker.getContainer(containerId);
		await container.commit({
			repo,
			tag,
			comment: 'treespec ephemeral',
			author: 'treespec',
		});
		return imageTag;
	} catch (err) {
		throw formatDockerError(err);
	}
}

/**
 * Force-remove an image tag (ignore if already gone).
 */
export async function removeImage(imageTag: string): Promise<void> {
	const docker = getDocker();
	try {
		await docker.getImage(imageTag).remove({ force: true });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// Ignore 404 — tag already removed (e.g. by treespec clean)
		if (msg.includes('404') || msg.includes('No such image')) {
			return;
		}
		throw formatDockerError(err);
	}
}

/**
 * List all local `treespec/ephemeral:*` image tags.
 */
export async function listEphemeralTags(): Promise<string[]> {
	const docker = getDocker();
	try {
		const images = await docker.listImages({
			filters: { reference: [`${EPHEMERAL_REPO}:*`] },
		});
		const tags: string[] = [];
		for (const img of images) {
			for (const rt of img.RepoTags ?? []) {
				if (rt.startsWith(`${EPHEMERAL_REPO}:`)) {
					tags.push(rt);
				}
			}
		}
		return [...new Set(tags)].sort();
	} catch (err) {
		throw formatDockerError(err);
	}
}

/**
 * Remove all `treespec/ephemeral:*` tags. Returns the tags that were removed.
 */
export async function cleanEphemeralTags(): Promise<string[]> {
	const tags = await listEphemeralTags();
	for (const tag of tags) {
		await removeImage(tag);
	}
	return tags;
}
