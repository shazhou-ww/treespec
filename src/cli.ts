/**
 * treespec — CLI commands
 */

import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
	buildImage,
	cleanEphemeralTags,
	imageExists,
	type BuildProgressEvent,
} from './docker.js';
import { loadEnvFile, mergeEnv } from './env.js';
import { runForest, type NodeResult, type RunSummary } from './runner.js';
import { parseConfig } from './schema.js';
import {
	countNodes,
	coveringSubtree,
	findNode,
	formatForest,
	scanSpecs,
	type TreeNode,
} from './scanner.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';

export function printHelp(): void {
	console.log(`treespec — tree-structured, stateful test system

Usage:
  treespec validate [--config <path>]              Validate treespec.yaml and the test tree
  treespec run [paths...] [--rebuild] [--env-file <path>] [--keep-tags]
                                                   DFS-execute the test tree (or covering subtrees)
  treespec clean                                   Remove all treespec/ephemeral:* tags
  treespec help                                    Show this help

Options:
  --config <path>     Path to treespec.yaml (default: ./treespec.yaml)
  --rebuild           Force rebuild of the base image even if the tag exists
  --env-file <path>   Override .env path (default: <config-dir>/.env)
  --keep-tags         Keep ephemeral image tags after the run (debug)
`);
}

function getFlagValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

/** Positional path args (not flags / flag values). */
function getPositionalArgs(args: string[]): string[] {
	const flagWithValue = new Set(['--config', '--env-file']);
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i]!;
		if (a.startsWith('-')) {
			if (flagWithValue.has(a)) i++;
			continue;
		}
		result.push(a);
	}
	return result;
}

async function loadProjectConfig(args: string[]): Promise<{
	configPath: string;
	configDir: string;
	config: ReturnType<typeof parseConfig>;
} | { error: string; code: number }> {
	const configFlag = getFlagValue(args, '--config');
	const configPath = resolve(process.cwd(), configFlag ?? 'treespec.yaml');
	const configDir = dirname(configPath);

	let configYaml: string;
	try {
		configYaml = await readFile(configPath, 'utf8');
	} catch {
		return { error: `cannot read config file: ${configPath}`, code: 1 };
	}

	try {
		const config = parseConfig(configYaml);
		return { configPath, configDir, config };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: `invalid treespec.yaml: ${message}`, code: 1 };
	}
}

function colorStatus(status: NodeResult['status']): string {
	if (status === 'PASS') return `${GREEN}${BOLD}PASS${RESET}`;
	if (status === 'FAIL') return `${RED}${BOLD}FAIL${RESET}`;
	return `${YELLOW}${BOLD}SKIP${RESET}`;
}

function toPosix(path: string): string {
	return path.split(sep).join('/');
}

/**
 * Resolve a user-supplied path to a node path relative to the specs root.
 */
function resolveNodePath(
	userPath: string,
	specsRoot: string,
	configDir: string,
): string {
	const abs = resolve(process.cwd(), userPath);
	const relToSpecs = relative(specsRoot, abs);
	if (relToSpecs && !relToSpecs.startsWith('..') && !relToSpecs.startsWith('/')) {
		return toPosix(relToSpecs).replace(/\/+$/, '');
	}
	const relToConfig = relative(configDir, abs);
	const specsName = toPosix(relative(configDir, specsRoot));
	if (relToConfig === specsName || relToConfig.startsWith(`${specsName}/`)) {
		return toPosix(relToConfig.slice(specsName.length).replace(/^\//, '')).replace(/\/+$/, '') || '.';
	}
	// Treat as path relative to specs root (e.g. help-command or provider-add/model-add)
	return toPosix(userPath).replace(/\/+$/, '').replace(/^\.\//, '');
}

/** Simple glob match: * (within segment) and ** (across segments). */
function matchGlob(pattern: string, value: string): boolean {
	const escapeRegex = (s: string) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	const parts = pattern.split('/');
	const regexParts = parts.map((part) => {
		if (part === '**') return '.*';
		return part.split('*').map(escapeRegex).join('[^/]*');
	});
	const re = new RegExp(`^${regexParts.join('/')}$`);
	return re.test(value);
}

function collectAllPaths(trees: TreeNode[]): string[] {
	const paths: string[] = [];
	function walk(nodes: TreeNode[]): void {
		for (const n of nodes) {
			paths.push(n.path);
			walk(n.children);
		}
	}
	walk(trees);
	return paths;
}

/**
 * Expand positional args (literal paths and globs) to node paths relative to specs root.
 */
function resolveTargetPaths(
	positionals: string[],
	trees: TreeNode[],
	specsRoot: string,
	configDir: string,
): { paths: string[]; error?: string } {
	const allPaths = collectAllPaths(trees);
	const resolved = new Set<string>();

	for (const p of positionals) {
		const hasGlob = /[*?]/.test(p) || p.includes('**');
		if (hasGlob) {
			const pattern = resolveNodePath(p, specsRoot, configDir);
			const matches = allPaths.filter((path) => matchGlob(pattern, path));
			if (matches.length === 0) {
				return { paths: [], error: `no nodes matched glob: ${p}` };
			}
			for (const m of matches) resolved.add(m);
			continue;
		}

		const nodePath = resolveNodePath(p, specsRoot, configDir);
		const node = findNode(trees, nodePath);
		if (!node) {
			return { paths: [], error: `node not found: ${p} (resolved: ${nodePath})` };
		}
		resolved.add(node.path);
	}

	return { paths: [...resolved] };
}

export async function runValidate(args: string[]): Promise<number> {
	const loaded = await loadProjectConfig(args);
	if ('error' in loaded) {
		console.error(`Error: ${loaded.error}`);
		return loaded.code;
	}

	const { configPath, configDir, config } = loaded;
	const specsRoot = resolve(configDir, config.specs);
	const result = await scanSpecs(specsRoot);
	const nodeCount = countNodes(result.trees);

	console.log(`Config: ${configPath}`);
	console.log(`Specs:  ${specsRoot}`);
	console.log(`Image:  ${config.image.tag} (dockerfile: ${config.image.dockerfile})`);
	if (config.llm) {
		console.log(`LLM:    ${config.llm.model} @ ${config.llm.base_url}`);
	}
	console.log(`Output: ${config.output ?? '.treespec-output'}`);
	console.log();

	if (result.trees.length === 0 && result.errors.length === 0) {
		console.log('Tree: (empty — no spec.yaml found)');
	} else if (result.trees.length > 0) {
		console.log('Tree:');
		console.log('S₀ (base image)');
		const forest = formatForest(result.trees);
		for (const line of forest.split('\n')) {
			console.log(`    ${line}`);
		}
	} else {
		console.log('Tree: (no valid nodes)');
	}

	console.log();
	console.log(`Nodes: ${nodeCount}`);
	console.log(`Roots: ${result.trees.length}`);

	if (result.envVars.length > 0) {
		console.log(`Env:   ${result.envVars.join(', ')}`);
	} else {
		console.log('Env:   (none declared)');
	}

	if (result.errors.length > 0) {
		console.log();
		console.error(`Errors (${result.errors.length}):`);
		for (const err of result.errors) {
			console.error(`  ✗ ${err.path}: ${err.message}`);
		}
		return 1;
	}

	console.log();
	console.log('✓ Valid');
	return 0;
}

function printBuildProgress(event: BuildProgressEvent): void {
	if (event.stream) {
		const text = event.stream.replace(/\n$/, '');
		if (text.length > 0) {
			console.log(text);
		}
		return;
	}
	if (event.status) {
		const parts = [event.id, event.status, event.progress].filter(Boolean);
		console.log(parts.join(' '));
	}
	if (event.error) {
		console.error(event.error);
	}
}

async function ensureBaseImage(
	config: ReturnType<typeof parseConfig>,
	configDir: string,
	rebuild: boolean,
): Promise<number> {
	const exists = await imageExists(config.image.tag);

	if (exists && !rebuild) {
		console.log(`skipping build, tag exists: ${config.image.tag}`);
		return 0;
	}

	if (exists && rebuild) {
		console.log(`Rebuilding image: ${config.image.tag}`);
	} else {
		console.log(`Building image: ${config.image.tag}`);
	}

	const tag = await buildImage(config.image, configDir, printBuildProgress);
	console.log();
	console.log(`✓ Built ${tag}`);
	return 0;
}

function printSummary(summary: RunSummary): void {
	console.log();
	console.log(
		`${BOLD}Summary${RESET}: ${summary.total} total, ` +
			`${GREEN}${summary.passed} passed${RESET}, ` +
			`${RED}${summary.failed} failed${RESET}, ` +
			`${YELLOW}${summary.skipped} skipped${RESET}`,
	);
}

export async function runRun(args: string[]): Promise<number> {
	const loaded = await loadProjectConfig(args);
	if ('error' in loaded) {
		console.error(`Error: ${loaded.error}`);
		return loaded.code;
	}

	const { configPath, configDir, config } = loaded;
	const rebuild = hasFlag(args, '--rebuild');
	const keepTags = hasFlag(args, '--keep-tags');
	const envFileFlag = getFlagValue(args, '--env-file');
	const positionals = getPositionalArgs(args);
	const envPath = envFileFlag
		? resolve(process.cwd(), envFileFlag)
		: join(configDir, '.env');

	if (envFileFlag) {
		try {
			await access(envPath);
		} catch {
			console.error(`Error: env file not found: ${envPath}`);
			return 1;
		}
	}

	const fileEnv = await loadEnvFile(envPath);
	const env = mergeEnv(fileEnv);
	for (const [key, value] of Object.entries(fileEnv)) {
		if (process.env[key] === undefined) {
			process.env[key] = env[key] ?? value;
		}
	}

	const specsRoot = resolve(configDir, config.specs);

	console.log(`Config: ${configPath}`);
	console.log(`Image:  ${config.image.tag}`);
	console.log(`Dockerfile: ${config.image.dockerfile}`);
	console.log(`Specs:  ${specsRoot}`);
	if (keepTags) {
		console.log(`Tags:   keep ephemeral (--keep-tags)`);
	}
	console.log();

	try {
		const buildCode = await ensureBaseImage(config, configDir, rebuild);
		if (buildCode !== 0) return buildCode;

		const scanned = await scanSpecs(specsRoot);
		if (scanned.errors.length > 0) {
			console.error(`Errors (${scanned.errors.length}):`);
			for (const err of scanned.errors) {
				console.error(`  ✗ ${err.path}: ${err.message}`);
			}
			return 1;
		}

		let treesToRun: TreeNode[];
		if (positionals.length === 0) {
			treesToRun = scanned.trees;
		} else {
			const { paths, error } = resolveTargetPaths(
				positionals,
				scanned.trees,
				specsRoot,
				configDir,
			);
			if (error) {
				console.error(`Error: ${error}`);
				return 1;
			}
			treesToRun = coveringSubtree(scanned.trees, paths);
			if (treesToRun.length === 0) {
				console.log('No nodes to run.');
				return 0;
			}
			console.log(`Covering subtree: ${paths.join(', ')}`);
			console.log();
		}

		if (treesToRun.length === 0) {
			console.log('No nodes to run.');
			return 0;
		}

		const summary = await runForest(treesToRun, config.image.tag, env, {
			keepTags,
			output: config.output,
			specsDir: specsRoot,
			onNode: ({ node, result, depth }) => {
				const pad = '  '.repeat(depth);
				const label = node.spec
					? node.path
					: `${node.path} [org]`;
				const desc = node.spec?.description ? ` ${DIM}— ${node.spec.description}${RESET}` : '';
				console.log(
					`${pad}${CYAN}▶${RESET} ${BOLD}${label}${RESET}${desc}  ${colorStatus(result.status)}  ${DIM}${result.reason}${RESET}`,
				);
			},
			onStep: ({ depth, index, stepSummary, stepResult, verdict, reason, context, postconName }) => {
				const pad = '  '.repeat(depth + 1);
				const mark = verdict === 'PASS' ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
				const exit = `${DIM}exit ${stepResult.exit_code}${RESET}`;
				const prefix = context === 'postcon' ? `postcon ${postconName} ` : '';
				console.log(`${pad}${mark} ${prefix}step ${index + 1}: ${stepSummary}  ${exit}`);
				if (verdict === 'FAIL') {
					console.log(`${pad}  ${RED}${reason}${RESET}`);
				}
			},
		});

		printSummary(summary);

		if (summary.failed > 0 || summary.skipped > 0) {
			return 1;
		}
		return 0;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Error: ${message}`);
		return 1;
	}
}

export async function runClean(_args: string[]): Promise<number> {
	try {
		const removed = await cleanEphemeralTags();
		if (removed.length === 0) {
			console.log('No treespec/ephemeral:* tags to remove.');
			return 0;
		}
		console.log(`Removed ${removed.length} ephemeral tag(s):`);
		for (const tag of removed) {
			console.log(`  ✗ ${tag}`);
		}
		return 0;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Error: ${message}`);
		return 1;
	}
}

export async function runCli(argv: string[]): Promise<number> {
	const args = argv.slice(2);
	const command = args[0];

	if (!command || command === 'help' || command === '--help' || command === '-h') {
		printHelp();
		return 0;
	}

	if (command === 'validate') {
		return runValidate(args.slice(1));
	}

	if (command === 'run') {
		return runRun(args.slice(1));
	}

	if (command === 'clean') {
		return runClean(args.slice(1));
	}

	console.error(`Unknown command: ${command}`);
	printHelp();
	return 1;
}
