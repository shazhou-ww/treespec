/**
 * treespec — CLI commands
 */

import { access } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { buildImage, imageExists, type BuildProgressEvent } from './docker.js';
import { loadEnvFile, mergeEnv } from './env.js';
import { runNode, type NodeResult } from './runner.js';
import { parseConfig } from './schema.js';
import { countNodes, findNode, formatForest, scanSpecs, type TreeNode } from './scanner.js';

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
  treespec run [path] [--rebuild] [--env-file <path>]
                                                   Execute node(s) (Phase 3: single-node)
  treespec help                                    Show this help

Options:
  --config <path>     Path to treespec.yaml (default: ./treespec.yaml)
  --rebuild           Force rebuild of the base image even if the tag exists
  --env-file <path>   Override .env path (default: <config-dir>/.env)
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

function printNodeResult(node: TreeNode, result: NodeResult): void {
	console.log();
	console.log(`${BOLD}${node.path}${RESET}  ${colorStatus(result.status)}  ${DIM}${result.reason}${RESET}`);
}

export async function runRun(args: string[]): Promise<number> {
	const loaded = await loadProjectConfig(args);
	if ('error' in loaded) {
		console.error(`Error: ${loaded.error}`);
		return loaded.code;
	}

	const { configPath, configDir, config } = loaded;
	const rebuild = hasFlag(args, '--rebuild');
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

		let nodesToRun: TreeNode[];
		if (positionals.length === 0) {
			nodesToRun = scanned.trees;
		} else {
			nodesToRun = [];
			for (const p of positionals) {
				const nodePath = resolveNodePath(p, specsRoot, configDir);
				const node = findNode(scanned.trees, nodePath);
				if (!node) {
					console.error(`Error: node not found: ${p} (resolved: ${nodePath})`);
					return 1;
				}
				nodesToRun.push(node);
			}
		}

		if (nodesToRun.length === 0) {
			console.log('No nodes to run.');
			return 0;
		}

		let anyNonPass = false;

		for (const node of nodesToRun) {
			console.log();
			console.log(`${CYAN}${BOLD}▶ ${node.path}${RESET}${node.spec?.description ? ` — ${node.spec.description}` : !node.spec ? ' [org]' : ''}`);

			const result = await runNode(node, config.image.tag, env, {
				onStep: ({ index, stepSummary, stepResult, verdict, reason }) => {
					const mark = verdict === 'PASS' ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
					const exit = `${DIM}exit ${stepResult.exit_code}${RESET}`;
					console.log(`  ${mark} step ${index + 1}: ${stepSummary}  ${exit}`);
					if (verdict === 'FAIL') {
						console.log(`    ${RED}${reason}${RESET}`);
					} else {
						console.log(`    ${DIM}${reason}${RESET}`);
					}
				},
			});

			printNodeResult(node, result);
			if (result.status !== 'PASS') {
				anyNonPass = true;
			}
		}

		console.log();
		if (anyNonPass) {
			console.log(`${RED}${BOLD}Done${RESET} — one or more nodes FAIL/SKIP`);
			return 1;
		}
		console.log(`${GREEN}${BOLD}Done${RESET} — all nodes PASS`);
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

	console.error(`Unknown command: ${command}`);
	printHelp();
	return 1;
}
