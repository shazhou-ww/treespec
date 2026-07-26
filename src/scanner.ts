/**
 * treespec — Recursively scan a specs directory into a test-case forest
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, sep } from 'node:path';
import { parseSpec } from './schema.js';
import type { Spec } from './types.js';

export interface TreeNode {
	/** Directory name (= case name). */
	name: string;
	/** Path relative to the specs root. */
	path: string;
	/**
	 * Parsed Spec from spec.yaml.
	 * Undefined = organizational node (pass-through; no steps / commit).
	 */
	spec?: Spec;
	children: TreeNode[];
}

export interface ScanError {
	/** Path relative to the specs root (or '.' for the root itself). */
	path: string;
	message: string;
}

export interface ScanResult {
	/** Forest of root nodes (parent = base image S₀). */
	trees: TreeNode[];
	errors: ScanError[];
	/** Deduplicated env var names declared across all specs. */
	envVars: string[];
}

/** Reserved directory name — assets are mounted via /specs, not tree children. */
export const ASSETS_DIR = 'assets';

async function listSubdirs(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter(
			(e) =>
				e.isDirectory() &&
				!e.name.startsWith('.') &&
				e.name !== ASSETS_DIR,
		)
		.map((e) => e.name)
		.sort();
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

function toPosix(path: string): string {
	return path.split(sep).join('/');
}

/**
 * Recursively scan `specsRoot` for test / organizational nodes.
 * - Has `spec.yaml` → test node
 * - No `spec.yaml` but has subdirectories → organizational node (pass-through)
 * - No `spec.yaml` and no subdirectories → error
 */
export async function scanSpecs(specsRoot: string): Promise<ScanResult> {
	const errors: ScanError[] = [];
	const envVars = new Set<string>();

	if (!(await pathExists(specsRoot))) {
		return {
			trees: [],
			errors: [{ path: '.', message: `Specs directory does not exist: ${specsRoot}` }],
			envVars: [],
		};
	}

	const rootStat = await stat(specsRoot);
	if (!rootStat.isDirectory()) {
		return {
			trees: [],
			errors: [{ path: '.', message: `Specs path is not a directory: ${specsRoot}` }],
			envVars: [],
		};
	}

	async function scanDir(absDir: string, relPath: string): Promise<TreeNode | null> {
		const childNames = await listSubdirs(absDir);
		const children: TreeNode[] = [];

		for (const childName of childNames) {
			const childAbs = join(absDir, childName);
			const childRel = relPath === '.' ? childName : `${relPath}/${childName}`;
			const child = await scanDir(childAbs, childRel);
			if (child) {
				children.push(child);
			}
		}

		// Specs root itself is not a node — return a synthetic holder via children only.
		if (relPath === '.') {
			return {
				name: '.',
				path: '.',
				children,
			};
		}

		const posixPath = toPosix(relPath);
		const specPath = join(absDir, 'spec.yaml');
		const hasSpec = await pathExists(specPath);

		if (hasSpec) {
			try {
				const yaml = await readFile(specPath, 'utf8');
				const spec = parseSpec(yaml);
				for (const name of spec.env ?? []) {
					envVars.add(name);
				}
				return {
					name: basename(relPath),
					path: posixPath,
					spec,
					children,
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				errors.push({
					path: posixPath,
					message: `Failed to parse spec.yaml: ${message}`,
				});
				return null;
			}
		}

		if (children.length > 0) {
			// Organizational node — pass-through, no steps / commit.
			return {
				name: basename(relPath),
				path: posixPath,
				children,
			};
		}

		errors.push({
			path: posixPath,
			message: 'Empty node: no spec.yaml and no subdirectories',
		});
		return null;
	}

	const rootHolder = await scanDir(specsRoot, '.');
	const trees = rootHolder?.children ?? [];

	function sortChildren(nodes: TreeNode[]): void {
		nodes.sort((a, b) => a.name.localeCompare(b.name));
		for (const n of nodes) {
			sortChildren(n.children);
		}
	}
	sortChildren(trees);

	return {
		trees,
		errors,
		envVars: [...envVars].sort(),
	};
}

/** Count nodes in a forest (including organizational nodes). */
export function countNodes(trees: TreeNode[]): number {
	let count = 0;
	function walk(nodes: TreeNode[]): void {
		for (const n of nodes) {
			count++;
			walk(n.children);
		}
	}
	walk(trees);
	return count;
}

/** Find a node by path relative to the specs root (posix, optional trailing slash). */
export function findNode(trees: TreeNode[], targetPath: string): TreeNode | undefined {
	const normalized = toPosix(targetPath).replace(/\/+$/, '');
	let found: TreeNode | undefined;

	function walk(nodes: TreeNode[]): void {
		for (const n of nodes) {
			if (n.path === normalized) {
				found = n;
				return;
			}
			walk(n.children);
			if (found) return;
		}
	}
	walk(trees);
	return found;
}

/** Render a forest as an indented tree string. */
export function formatForest(trees: TreeNode[]): string {
	const lines: string[] = [];
	function walk(nodes: TreeNode[], isLastList: boolean[]): void {
		nodes.forEach((node, index) => {
			const isLast = index === nodes.length - 1;
			const branch = isLast ? '└── ' : '├── ';
			const indent = isLastList.map((last) => (last ? '    ' : '│   ')).join('');
			if (!node.spec) {
				lines.push(`${indent}${branch}${node.name} [org]`);
			} else {
				const env = node.spec.env?.length ? ` [env: ${node.spec.env.join(', ')}]` : '';
				const desc = node.spec.description ? ` — ${node.spec.description}` : '';
				lines.push(`${indent}${branch}${node.name}${desc}${env}`);
			}
			walk(node.children, [...isLastList, isLast]);
		});
	}
	walk(trees, []);
	return lines.join('\n');
}

/**
 * Build the minimal covering forest for a set of target paths:
 * ancestors of each target + the target + all descendants of each target.
 * Sibling branches outside the cover are dropped.
 */
export function coveringSubtree(
	trees: TreeNode[],
	targetPaths: string[],
): TreeNode[] {
	const include = new Set<string>();

	function addAncestors(path: string): void {
		const parts = path.split('/').filter(Boolean);
		for (let i = 1; i < parts.length; i++) {
			include.add(parts.slice(0, i).join('/'));
		}
	}

	function addSubtree(node: TreeNode): void {
		include.add(node.path);
		for (const child of node.children) {
			addSubtree(child);
		}
	}

	for (const targetPath of targetPaths) {
		const normalized = toPosix(targetPath).replace(/\/+$/, '');
		const node = findNode(trees, normalized);
		if (!node) continue;
		addAncestors(normalized);
		addSubtree(node);
	}

	function filter(nodes: TreeNode[]): TreeNode[] {
		return nodes
			.filter((n) => include.has(n.path))
			.map((n) => ({
				...n,
				children: filter(n.children),
			}));
	}

	return filter(trees);
}
