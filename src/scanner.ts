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
	/** Parsed Spec from spec.yaml. */
	spec: Spec;
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

async function listSubdirs(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
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
 * Recursively scan `specsRoot` for directories containing `spec.yaml`.
 * Root-level directories under the specs root become forest roots.
 * Directories missing `spec.yaml` are reported as errors.
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

	const nodesByPath = new Map<string, TreeNode>();

	async function collect(absDir: string, relPath: string): Promise<void> {
		const childNames = await listSubdirs(absDir);

		if (relPath !== '.') {
			const posixPath = toPosix(relPath);
			const specPath = join(absDir, 'spec.yaml');
			if (!(await pathExists(specPath))) {
				errors.push({ path: posixPath, message: 'Missing spec.yaml' });
			} else {
				try {
					const yaml = await readFile(specPath, 'utf8');
					const spec = parseSpec(yaml);
					for (const name of spec.env ?? []) {
						envVars.add(name);
					}
					nodesByPath.set(posixPath, {
						name: basename(relPath),
						path: posixPath,
						spec,
						children: [],
					});
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					errors.push({
						path: posixPath,
						message: `Failed to parse spec.yaml: ${message}`,
					});
				}
			}
		}

		for (const childName of childNames) {
			const childAbs = join(absDir, childName);
			const childRel = relPath === '.' ? childName : `${relPath}/${childName}`;
			await collect(childAbs, childRel);
		}
	}

	await collect(specsRoot, '.');

	// Assemble forest: parent = longest existing ancestor path with a node.
	const sortedPaths = [...nodesByPath.keys()].sort(
		(a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
	);

	const trees: TreeNode[] = [];

	for (const path of sortedPaths) {
		const node = nodesByPath.get(path)!;
		const parts = path.split('/');
		let parent: TreeNode | undefined;
		for (let i = parts.length - 1; i >= 1; i--) {
			const ancestorPath = parts.slice(0, i).join('/');
			const ancestor = nodesByPath.get(ancestorPath);
			if (ancestor) {
				parent = ancestor;
				break;
			}
		}
		if (parent) {
			parent.children.push(node);
		} else {
			trees.push(node);
		}
	}

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

/** Count nodes in a forest. */
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

/** Render a forest as an indented tree string. */
export function formatForest(trees: TreeNode[]): string {
	const lines: string[] = [];
	function walk(nodes: TreeNode[], isLastList: boolean[]): void {
		nodes.forEach((node, index) => {
			const isLast = index === nodes.length - 1;
			const branch = isLast ? '└── ' : '├── ';
			const indent = isLastList.map((last) => (last ? '    ' : '│   ')).join('');
			const env = node.spec.env?.length ? ` [env: ${node.spec.env.join(', ')}]` : '';
			const desc = node.spec.description ? ` — ${node.spec.description}` : '';
			lines.push(`${indent}${branch}${node.name}${desc}${env}`);
			walk(node.children, [...isLastList, isLast]);
		});
	}
	walk(trees, []);
	return lines.join('\n');
}
