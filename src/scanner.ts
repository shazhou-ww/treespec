/**
 * treespec — Recursively scan a specs directory into a test-case forest
 *
 * Each test case = a directory containing `spec.yaml`.
 * Child discovery is explicit via `primary` + `branches` fields in spec.yaml.
 * Subdirectories with `spec.yaml` not listed in primary/branches → warning.
 * Subdirectories without `spec.yaml` → silently ignored (assets, fixtures, etc.).
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
	/** Parsed Spec from spec.yaml. Always present — every node must have spec.yaml. */
	spec: Spec;
	/** Primary child (嫡长子) — the main-line continuation. Undefined for leaf nodes. */
	primary?: TreeNode;
	/** Branch children — additional sub-trees that fork off the main line. */
	branches: TreeNode[];
}

export interface ScanError {
	/** Path relative to the specs root (or '.' for the root itself). */
	path: string;
	message: string;
}

export interface ScanWarning {
	/** Path relative to the specs root. */
	path: string;
	message: string;
}

export interface ScanResult {
	/** Forest of root nodes (parent = base image S₀). */
	trees: TreeNode[];
	errors: ScanError[];
	warnings: ScanWarning[];
	/** Deduplicated env var names declared across all specs. */
	envVars: string[];
}

/** All children of a node: primary first (if present), then branches. */
export function allChildren(node: TreeNode): TreeNode[] {
	return [...(node.primary ? [node.primary] : []), ...node.branches];
}

async function listSubdirs(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return entries
		.filter((e) => e.isDirectory() && !e.name.startsWith('.'))
		.map((e) => e.name);
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
 * Recursively scan `specsRoot` for test nodes.
 * - Has `spec.yaml` → test node (children from primary/branches)
 * - No `spec.yaml` → ignored (not a node)
 */
export async function scanSpecs(specsRoot: string): Promise<ScanResult> {
	const errors: ScanError[] = [];
	const warnings: ScanWarning[] = [];
	const envVars = new Set<string>();

	if (!(await pathExists(specsRoot))) {
		return {
			trees: [],
			errors: [{ path: '.', message: `Specs directory does not exist: ${specsRoot}` }],
			warnings: [],
			envVars: [],
		};
	}

	const rootStat = await stat(specsRoot);
	if (!rootStat.isDirectory()) {
		return {
			trees: [],
			errors: [{ path: '.', message: `Specs path is not a directory: ${specsRoot}` }],
			warnings: [],
			envVars: [],
		};
	}

	async function scanDir(absDir: string, relPath: string): Promise<TreeNode | null> {
		const subdirs = await listSubdirs(absDir);

		// Find which subdirs have spec.yaml (potential children)
		const specSubdirs: string[] = [];
		for (const sub of subdirs) {
			const subSpecPath = join(absDir, sub, 'spec.yaml');
			if (await pathExists(subSpecPath)) {
				specSubdirs.push(sub);
			}
		}

		const posixPath = toPosix(relPath);
		const specPath = join(absDir, 'spec.yaml');

		// Root without spec.yaml → forest of independent trees (backward compat).
		if (relPath === '.' && !(await pathExists(specPath))) {
			const children: TreeNode[] = [];
			for (const sub of specSubdirs) {
				const child = await scanDir(join(absDir, sub), sub);
				if (child) children.push(child);
			}
			return children.length > 0
				? { name: 'root', path: '.', spec: { steps: [] }, branches: children }
				: null;
		}

		if (!(await pathExists(specPath))) {
			// Not a test node — skip silently.
			return null;
		}

		let spec: Spec;
		try {
			const yaml = await readFile(specPath, 'utf8');
			spec = parseSpec(yaml);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			errors.push({
				path: posixPath,
				message: `Failed to parse spec.yaml: ${message}`,
			});
			return null;
		}

		for (const name of spec.env ?? []) {
			envVars.add(name);
		}

		// Validate: branches without primary is invalid
		if (spec.branches && spec.branches.length > 0 && !spec.primary) {
			errors.push({
				path: posixPath,
				message: 'branches declared without primary — primary is required when children exist',
			});
		}

		// Resolve children from primary/branches
		const declaredNames = new Set<string>();
		if (spec.primary) declaredNames.add(spec.primary);
		if (spec.branches) for (const b of spec.branches) declaredNames.add(b);

		// Warn for spec.yaml subdirs not declared
		for (const sub of specSubdirs) {
			if (!declaredNames.has(sub)) {
				warnings.push({
					path: posixPath,
					message: `subdirectory "${sub}" has spec.yaml but is not declared in primary/branches`,
				});
			}
		}

		// Resolve primary child
		let primaryNode: TreeNode | undefined;
		if (spec.primary) {
			const primaryAbs = join(absDir, spec.primary);
			const primaryNodeOrNull = await scanDir(primaryAbs, `${relPath === '.' ? '' : relPath + '/'}${spec.primary}`);
			if (primaryNodeOrNull) {
				primaryNode = primaryNodeOrNull;
			} else {
				errors.push({
					path: posixPath,
					message: `primary child "${spec.primary}" not found or has no valid spec.yaml`,
				});
			}
		}

		// Resolve branch children
		const branchNodes: TreeNode[] = [];
		if (spec.branches) {
			for (const branchName of spec.branches) {
				const branchAbs = join(absDir, branchName);
				const branchNode = await scanDir(branchAbs, `${relPath === '.' ? '' : relPath + '/'}${branchName}`);
				if (branchNode) {
					branchNodes.push(branchNode);
				} else {
					errors.push({
						path: posixPath,
						message: `branch child "${branchName}" not found or has no valid spec.yaml`,
					});
				}
			}
		}

		return {
			name: relPath === '.' ? 'root' : basename(relPath),
			path: posixPath,
			spec,
			primary: primaryNode,
			branches: branchNodes,
		};
	}

	const root = await scanDir(specsRoot, '.');
	// Root with spec.yaml → single tree. Root without → forest.
	const trees = root
		? (root.spec.steps.length > 0 || root.primary) ? [root] : root.branches
		: [];

	return {
		trees,
		errors,
		warnings,
		envVars: [...envVars].sort(),
	};
}

/**
 * Find the primary chain from root(s) to a target node.
 * Follows `primary` links only — returns [] if target is a branch (小宗).
 */
export function findPrimaryAncestors(trees: TreeNode[], targetPath: string): TreeNode[] {
	const normalized = toPosix(targetPath).replace(/\/+$/, '');
	const chain: TreeNode[] = [];
	function walk(node: TreeNode): boolean {
		chain.push(node);
		if (node.path === normalized) return true;
		if (node.primary && walk(node.primary)) return true;
		chain.pop();
		return false;
	}
	for (const tree of trees) {
		if (walk(tree)) return chain;
	}
	return [];
}

/**
 * Follow `primary` children from a node to leaf.
 * Returns the descendant chain (NOT including the starting node).
 */
export function primaryDescendants(node: TreeNode): TreeNode[] {
	const chain: TreeNode[] = [];
	let current = node.primary;
	while (current) {
		chain.push(current);
		current = current.primary;
	}
	return chain;
}

/** Count nodes in a forest. */
export function countNodes(trees: TreeNode[]): number {
	let count = 0;
	function walk(nodes: TreeNode[]): void {
		for (const n of nodes) {
			count++;
			walk(allChildren(n));
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
			walk(allChildren(n));
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
			const env = node.spec.env?.length ? ` [env: ${node.spec.env.join(', ')}]` : '';
			const postcon = node.spec.postcon?.length
				? node.spec.postcon.map((p) => ` [postcon: ${p.name}]`).join('')
				: '';
			const desc = node.spec.description ? ` — ${node.spec.description}` : '';
			lines.push(`${indent}${branch}${node.name}${desc}${env}${postcon}`);
			walk(allChildren(node), [...isLastList, isLast]);
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
		for (const child of allChildren(node)) {
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
				primary: n.primary && include.has(n.primary.path) ? filter([n.primary])[0] : undefined,
				branches: filter(n.branches),
			}));
	}

	return filter(trees);
}
