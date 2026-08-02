/**
 * treespec — CLI commands
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LlmConfig } from './config.js';
import {
	buildImage,
	cleanEphemeralTags,
	imageExists,
	pullImageIfMissing,
	type BuildProgressEvent,
} from './docker.js';
import { loadEnvFile, mergeEnv } from './env.js';
import { runForest, type NodeResult, type RunSummary } from './runner.js';
import { parseConfig } from './schema.js';
import {
	allChildren,
	countNodes,
	coveringSubtree,
	findNode,
	findPrimaryAncestors,
	formatForest,
	primaryDescendants,
	scanSpecs,
	type TreeNode,
} from './scanner.js';
import { isHttpStepResult } from './steps.js';
import { createTraceWriter } from './trace.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const CYAN = '\x1b[36m';

/** Color "N label" only when N is non-zero; zero is noise, no emphasis. */
function coloredPhrase(n: number, label: string, color: string): string {
	return n > 0 ? `${color}${n} ${label}${RESET}` : `${n} ${label}`;
}

const __moduleDir = dirname(fileURLToPath(import.meta.url));

function loadHelp(name: string): string {
	const pkg = JSON.parse(readFileSync(join(__moduleDir, '..', 'package.json'), 'utf8'));
	const version = pkg.version ?? '0.0.0';
	const helpPath = join(__moduleDir, '..', 'help', `${name}.md`);
	try {
		const content = readFileSync(helpPath, 'utf8');
		return content.replace(/\{\{version\}\}/g, version);
	} catch {
		return `treespec v${version} — tree-structured, stateful test system\n\n( help file not found: ${name}.md )\n`;
	}
}

export function printHelp(): void {
	console.log(loadHelp('main'));
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
	const flagWithValue = new Set([
		'--config',
		'--env-file',
		'--image',
		'--output',
	'--name',
]);
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
	suiteName: string;
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

	let config: ReturnType<typeof parseConfig>;
	try {
		config = parseConfig(configYaml);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { error: `invalid treespec.yaml: ${message}`, code: 1 };
	}

	// Resolve suite name: config.name → directory basename
	const suiteName = config.name ?? basename(configDir);

	// Resolve image tag default from suite name
	if (config.image && !config.image.tag) {
		config.image.tag = `${suiteName}-test:base`;
	}

	return { configPath, configDir, config, suiteName };
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
			walk(allChildren(n));
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

function resolveLlmConfig(): LlmConfig | undefined {
	const baseUrl = process.env.TREESPEC_LLM_BASE_URL;
	const model = process.env.TREESPEC_LLM_MODEL;
	const apiKey = process.env.TREESPEC_LLM_API_KEY;
	if (!baseUrl || !model || !apiKey) return undefined;
	return { base_url: baseUrl, model, api_key: apiKey };
}

export async function runValidate(args: string[]): Promise<number> {
	const loaded = await loadProjectConfig(args);
	if ('error' in loaded) {
		console.error(`Error: ${loaded.error}`);
		return loaded.code;
	}

	const { configPath, configDir, config } = loaded;
	const projectDir = resolve(configDir, config.projectDir ?? '.');
	const specsRoot = resolve(projectDir, config.spec);
	const result = await scanSpecs(specsRoot);
	const nodeCount = countNodes(result.trees);

	console.log(`Config: ${configPath}`);
	console.log(`Project: ${projectDir}`);
	console.log(`Specs:  ${specsRoot}`);
	if (config.docker?.network) {
		console.log(`Docker: network=${config.docker.network}` +
			(config.docker.extra_hosts ? `, extra_hosts=${config.docker.extra_hosts.join(',')}` : ''));
	}
	console.log(
		`Image:  ${config.image?.tag ?? '(none)'}` +
			(config.image?.dockerfile ? ` (dockerfile: ${config.image.dockerfile})` : ' (no dockerfile)'),
	);
	const llm = resolveLlmConfig();
	if (llm) {
		console.log(`LLM:    ${llm.model} @ ${llm.base_url}`);
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

	if (result.warnings.length > 0) {
		console.log();
		for (const warn of result.warnings) {
			console.warn(`  ⚠ ${warn.path}: ${warn.message}`);
		}
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

/**
 * Resolve the base image tag to use for a run.
 * Priority: --image > image.dockerfile > error.
 */
async function resolveBaseImage(
	config: ReturnType<typeof parseConfig>,
	configDir: string,
	args: string[],
): Promise<{ tag: string } | { error: string; code: number }> {
	const imageFlag = getFlagValue(args, '--image');
	const rebuild = hasFlag(args, '--rebuild');

	if (imageFlag && rebuild) {
		return {
			error: '--rebuild is only valid when building from image.dockerfile (not with --image)',
			code: 1,
		};
	}

	if (imageFlag) {
		console.log(`Using image: ${imageFlag} (--image, skip build)`);
		await pullImageIfMissing(imageFlag);
		return { tag: imageFlag };
	}

	if (!config.image?.dockerfile) {
		return {
			error:
				'no image source: pass --image <tag> or set image.dockerfile in treespec.yaml',
			code: 1,
		};
	}

	const imageTag = config.image.tag;
	if (!imageTag) {
		return {
			error: 'image.tag not resolved — set name or image.tag in treespec.yaml',
			code: 1,
		};
	}

	const exists = await imageExists(imageTag);

	if (exists && !rebuild) {
		console.log(`skipping build, tag exists: ${imageTag}`);
		return { tag: imageTag };
	}

	if (exists && rebuild) {
		console.log(`Rebuilding image: ${imageTag}`);
	} else {
		console.log(`Building image: ${imageTag}`);
	}

	const tag = await buildImage(config.image, configDir, printBuildProgress);
	console.log();
	console.log(`✓ Built ${tag}`);
	return { tag };
}

function printSummary(summary: RunSummary): void {
	console.log();
	const duration =
		summary.duration_ms !== undefined
			? ` ${DIM}(${summary.duration_ms}ms)${RESET}`
			: '';
	console.log(
		`${BOLD}Summary${RESET}: ${summary.total} total, ` +
			`${coloredPhrase(summary.passed, 'passed', GREEN)}, ` +
			`${coloredPhrase(summary.failed, 'failed', RED)}, ` +
			`${coloredPhrase(summary.skipped, 'skipped', YELLOW)}${duration}`,
	);
}

export async function runRun(args: string[]): Promise<number> {
	const loaded = await loadProjectConfig(args);
	if ('error' in loaded) {
		console.error(`Error: ${loaded.error}`);
		return loaded.code;
	}

	const { configPath, configDir, config, suiteName } = loaded;
	const keepTags = hasFlag(args, '--keep-tags');
	const verbose = hasFlag(args, '--verbose') || hasFlag(args, '-v');
	const noTrace = hasFlag(args, '--no-trace');
	const envFileFlag = getFlagValue(args, '--env-file');
	const outputFlag = getFlagValue(args, '--output');
	const imageFlag = getFlagValue(args, '--image');
	const positionals = getPositionalArgs(args);
	const envPath = envFileFlag
		? resolve(process.cwd(), envFileFlag)
		: join(configDir, '.env');
	const outputDir = resolve(
		configDir,
		outputFlag ?? config.output ?? '.treespec-output',
	);

	if (envFileFlag) {
		try {
			await access(envPath);
		} catch {
			console.error(`Error: env file not found: ${envPath}`);
			return 1;
		}
	}

	let llm: LlmConfig | undefined;
	try {
		llm = resolveLlmConfig();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Error: ${message}`);
		return 1;
	}

	const fileEnv = await loadEnvFile(envPath);
	const env = mergeEnv(fileEnv);
	for (const [key, value] of Object.entries(fileEnv)) {
		if (process.env[key] === undefined) {
			process.env[key] = env[key] ?? value;
		}
	}

	const specsRoot = resolve(
		resolve(configDir, config.projectDir ?? '.'),
		config.spec,
	);

	console.log(`Config: ${configPath}`);
	if (imageFlag) {
		console.log(`Image:  ${imageFlag} (--image)`);
	} else {
		console.log(`Image:  ${config.image?.tag ?? '(none)'}`);
		if (config.image?.dockerfile) {
			console.log(`Dockerfile: ${config.image.dockerfile}`);
		}
	}
	console.log(`Specs:  ${specsRoot}`);
	console.log(`Output: ${outputDir}${noTrace ? ' (no-trace)' : ''}`);
	if (llm) {
		console.log(`LLM:    ${llm.model} @ ${llm.base_url}`);
	}
	if (keepTags) {
		console.log(`Tags:   keep ephemeral (--keep-tags)`);
	}
	console.log();

	try {
		const resolved = await resolveBaseImage(config, configDir, args);
		if ('error' in resolved) {
			console.error(`Error: ${resolved.error}`);
			return resolved.code;
		}
		const baseTag = resolved.tag;

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

		const writeTrace = !noTrace;
		const trace = await createTraceWriter(outputDir, writeTrace, suiteName);
		if (writeTrace && trace.filePath) {
			console.log(`Trace:  ${trace.filePath}`);
			console.log();
		}

		const summary = await runForest(treesToRun, baseTag, env, {
			keepTags,
			output: outputDir,
			writeTrace,
			trace,
			llm,
		baseImage: baseTag,
		projectDir: resolve(configDir, config.projectDir ?? '.'),
		specRelative: config.spec,
		network: config.docker?.network,
			extraHosts: config.docker?.extra_hosts,
			onNode: ({ node, result, depth }) => {
				const pad = '  '.repeat(depth);
				const label = node.path;
			const desc = node.spec.description ? ` ${DIM}— ${node.spec.description}${RESET}` : '';
				console.log(
					`${pad}${CYAN}▶${RESET} ${BOLD}${label}${RESET}${desc}  ${colorStatus(result.status)}  ${DIM}${result.reason}${RESET}`,
				);
			},
			onStep: ({ depth, index, stepSummary, stepResult, verdict, reason, context, postconName }) => {
				const pad = '  '.repeat(depth + 1);
				const mark = verdict === 'PASS' ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
				const detail = isHttpStepResult(stepResult)
					? `${DIM}status ${stepResult.status}${RESET}`
					: `${DIM}exit ${stepResult.exit_code}${RESET}`;
				const prefix = context === 'postcon' ? `postcon ${postconName} ` : '';
				console.log(`${pad}${mark} ${prefix}step ${index + 1}: ${stepSummary}  ${detail}`);
				if (verdict === 'FAIL') {
					console.log(`${pad}  ${RED}${reason}${RESET}`);
				}
				if (verbose) {
					if (isHttpStepResult(stepResult)) {
						console.log(`${pad}  ${DIM}body:${RESET}`);
						console.log(stepResult.body);
					} else {
						if (stepResult.stdout) {
							console.log(`${pad}  ${DIM}stdout:${RESET}`);
							console.log(stepResult.stdout);
						}
						if (stepResult.stderr) {
							console.log(`${pad}  ${DIM}stderr:${RESET}`);
							console.log(stepResult.stderr);
						}
					}
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
		const stack = err instanceof Error ? err.stack : '';
		console.error(`Error: ${message}`);
		if (stack) console.error(stack);
		return 1;
	}
}

export async function runTreeCmd(args: string[]): Promise<number> {
	const loaded = await loadProjectConfig(args);
	if ('error' in loaded) {
		console.error(`Error: ${loaded.error}`);
		return loaded.code;
	}

	const { configDir, config } = loaded;
	const specsRoot = resolve(
		resolve(configDir, config.projectDir ?? '.'),
		config.spec,
	);
	const result = await scanSpecs(specsRoot);

	if (result.errors.length > 0) {
		console.error(`Errors (${result.errors.length}):`);
		for (const err of result.errors) {
			console.error(`  ✗ ${err.path}: ${err.message}`);
		}
		return 1;
	}

	console.log('S₀ (base image)');
	if (result.trees.length === 0) {
		console.log('(empty — no spec.yaml found)');
		return 0;
	}
	console.log(formatForest(result.trees));
	return 0;
}

// ─── lineage ──────────────────────────────────────────────────

/** Format a single node as a list entry (name + description). */
function formatLineageNode(node: TreeNode, isStart: boolean): string {
	const desc = node.spec.description ? ` — ${node.spec.description}` : '';
	const marker = isStart ? ' ← here' : '';
	return `${node.name}${desc}${marker}`;
}

/** Format step details for verbose output. */
function formatStepDetails(steps: TreeNode['spec']['steps']): string[] {
	const lines: string[] = [];
	if (!steps.length) {
		lines.push('  (no steps — container/passthrough node)');
		return lines;
	}
	lines.push('  steps:');
	steps.forEach((step, i) => {
		const num = `${i + 1}.`;
		if (step.type === 'exec') {
			// Show first line only for readability; multi-line commands (heredocs) are truncated
			const firstLine = step.command.split('\n')[0] ?? '';
			const cmd = firstLine.length > 80 ? firstLine.slice(0, 77) + '...' : firstLine;
			lines.push(`    ${num} exec: ${cmd}`);
		} else {
			lines.push(`    ${num} http: ${step.request.method} ${step.request.url}`);
		}
	});
	return lines;
}

/** Format assert details for verbose output. */
function formatAssertDetails(assert: TreeNode['spec']['steps'][number]['assert']): string[] {
	const lines: string[] = [];
	if (!assert) return lines;
	switch (assert.type) {
		case 'regex':
			lines.push(`  assert: regex`);
			for (const c of assert.conditions) {
				lines.push(`    ${c.path} =~ /${c.regex}/`);
			}
			break;
		case 'jsonata':
			lines.push(`  assert: jsonata ${assert.expression}`);
			break;
		case 'llm':
			lines.push(`  assert: llm "${assert.prompt}"`);
			break;
	}
	return lines;
}

/** Format postcon details for verbose output. */
function formatPostconDetails(postcon: TreeNode['spec']['postcon']): string[] {
	const lines: string[] = [];
	if (!postcon?.length) return lines;
	for (const p of postcon) {
		lines.push(`  postcon: ${p.name} (${p.steps.length} steps)`);
	}
	return lines;
}

/** Format the full lineage as a linear list. */
function formatLineage(
	ancestors: TreeNode[],
	start: TreeNode,
	descendants: TreeNode[],
	opts: { showSteps: boolean; showAsserts: boolean; showPostcon: boolean },
): string {
	const lines: string[] = [];
	const fullList = [...ancestors, start, ...descendants];

	for (let i = 0; i < fullList.length; i++) {
		const node = fullList[i]!;
		const isStart = node === start;
		const isLast = i === fullList.length - 1;

		// Node header line — mark start with ← here only when ancestors are shown
		lines.push(formatLineageNode(node, isStart && ancestors.length > 0 && !descendants.length));

		// Detail lines
		if (opts.showSteps) {
			lines.push(...formatStepDetails(node.spec.steps));
		}
		if (opts.showAsserts) {
			// Find first step with assert for display
			const stepWithAssert = node.spec.steps.find((s) => s.assert);
			lines.push(...formatAssertDetails(stepWithAssert?.assert));
		}
		if (opts.showPostcon) {
			lines.push(...formatPostconDetails(node.spec.postcon));
		}

		// Show primary pointer (if not leaf)
		if (node.primary) {
			if (opts.showSteps || opts.showAsserts || opts.showPostcon) {
				lines.push(`  primary → ${node.primary.name}`);
			}
		} else if (isLast && (opts.showSteps || opts.showAsserts || opts.showPostcon)) {
			lines.push('  (leaf)');
		}
	}

	return lines.join('\n');
}

export async function runLineage(args: string[]): Promise<number> {
	const loaded = await loadProjectConfig(args);
	if ('error' in loaded) {
		console.error(`Error: ${loaded.error}`);
		return loaded.code;
	}

	const { configDir, config } = loaded;
	const specsRoot = resolve(
		resolve(configDir, config.projectDir ?? '.'),
		config.spec,
	);
	const result = await scanSpecs(specsRoot);

	if (result.errors.length > 0) {
		console.error(`Errors (${result.errors.length}):`);
		for (const err of result.errors) {
			console.error(`  ✗ ${err.path}: ${err.message}`);
		}
		return 1;
	}

	if (result.trees.length === 0) {
		console.log('(empty — no spec.yaml found)');
		return 0;
	}

	// Parse flags
	const onlyAncestors = hasFlag(args, '--only-ancestors');
	const onlyDescends = hasFlag(args, '--only-descends');
	const verbose = hasFlag(args, '--verbose') || hasFlag(args, '-v');
	const opts = {
		showSteps: verbose || hasFlag(args, '--steps'),
		showAsserts: verbose || hasFlag(args, '--asserts'),
		showPostcon: verbose || hasFlag(args, '--postcon'),
	};

	// Find starting node
	const positionals = getPositionalArgs(args);
	const nodeArg = positionals[0];

	let startNode: TreeNode;
	let ancestors: TreeNode[] = [];
	let descendants: TreeNode[] = [];

	if (!nodeArg) {
		// No node specified — start from root
		startNode = result.trees[0]!;
	} else {
		// Normalize: strip trailing /spec.yaml if given a file path
		const normalized = nodeArg
			.replace(/\/spec\.yaml$/, '')
			.replace(/\/+$/, '');
		const found = findNode(result.trees, normalized);
		if (!found) {
			console.error(`Error: node not found: ${nodeArg}`);
			return 1;
		}
		startNode = found;
	}

	// Compute ancestors and descendants based on scope
	if (!onlyDescends) {
		ancestors = findPrimaryAncestors(result.trees, startNode.path);
		// Remove the start node itself from ancestors (it's included)
		ancestors = ancestors.filter((n) => n.path !== startNode.path);
	}

	if (!onlyAncestors) {
		descendants = primaryDescendants(startNode);
	}

	// Handle branch nodes (not on primary chain)
	if (ancestors.length === 0 && !onlyDescends && nodeArg) {
		// Node is a branch (小宗) — no primary ancestors
		console.error(`Note: "${startNode.name}" is a branch node (小宗), not on the primary chain.`);
		console.error('Use --only-descends to show its primary descendants, or `tree` to see the full tree.');
		return 0;
	}

	console.log(formatLineage(ancestors, startNode, descendants, opts));
	return 0;
}

export async function runInit(args: string[]): Promise<number> {
	const positionals = getPositionalArgs(args);
	const target = positionals[0];
	if (!target) {
		console.error('Error: treespec init requires a path');
		console.error('Usage: treespec init <path> [--name <name>]');
		return 1;
	}

	const nameFlag = getFlagValue(args, '--name');
	const root = resolve(process.cwd(), target);
	const specDir = join(root, 'spec');
	const exampleDir = join(specDir, 'example');
	const configPath = join(root, 'treespec.yaml');
	const projectName = nameFlag ?? (basename(resolve(process.cwd(), target)) || 'myapp');

	try {
		await access(configPath);
		console.error(`Error: already exists: ${configPath}`);
		return 1;
	} catch {
		// ok — does not exist
	}

	try {
		await mkdir(exampleDir, { recursive: true });

		const configYaml = `name: ${projectName}

image:
  dockerfile: spec/Dockerfile
  # tag: ${projectName}-test:base   # default: <name>-test:base

# projectDir defaults to "." (this directory).
# Mounted read-only at /app inside every container.
# Override with a relative path if treespec.yaml is not at project root:
# projectDir: ..

spec: spec

# output: .treespec-output           # default: .treespec-output
`;

		const dockerfile = `FROM node:22-alpine

WORKDIR /app

# Project source, node_modules, and dist are mounted from host at runtime.
# Add node_modules/.bin to PATH so project CLIs are directly callable.
ENV PATH="/app/node_modules/.bin:$PATH"
`;

		const exampleSpec = `description: "example — echo hello"
steps:
  - type: exec
    command: "echo hello"
    assert:
      type: regex
      conditions:
        - { path: "stdout", regex: "hello" }
`;

		await writeFile(configPath, configYaml, 'utf8');
		await writeFile(join(specDir, 'Dockerfile'), dockerfile, 'utf8');
		await writeFile(join(exampleDir, 'spec.yaml'), exampleSpec, 'utf8');

		console.log(`Created treespec project at ${root}`);
		console.log('  treespec.yaml');
		console.log('  spec/Dockerfile');
		console.log('  spec/example/spec.yaml');
		return 0;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Error: ${message}`);
		return 1;
	}
}

export async function runShow(args: string[]): Promise<number> {
	const positionals = getPositionalArgs(args);
	const verbose = hasFlag(args, '--verbose') || hasFlag(args, '-v');
	const failuresOnly = hasFlag(args, '--failures') || hasFlag(args, '-f');

	const tracePath = positionals[0];
	if (!tracePath) {
		console.error('Error: treespec show requires a trace file path');
		console.error('Usage: treespec show <trace.jsonl> [options]');
		return 1;
	}

	const absPath = resolve(process.cwd(), tracePath);
	let content: string;
	try {
		content = await readFile(absPath, 'utf8');
	} catch {
		console.error(`Error: cannot read trace file: ${absPath}`);
		return 1;
	}

	const lines = content.split('\n').filter((l) => l.trim());
	const records: Array<Record<string, unknown>> = [];
	for (const line of lines) {
		try {
			records.push(JSON.parse(line));
		} catch {
			// skip malformed lines
		}
	}

	const meta = records.find((r) => r.type === 'meta');
	const summary = records.find((r) => r.type === 'summary');
	const steps = records.filter((r) => r.type === 'step') as Array<
		Record<string, unknown> & {
			node_path: string;
			index: number;
			command: string;
			stdout: string;
			stderr: string;
			exit_code: number;
			verdict: string;
			reason: string;
			duration_ms: number;
		}
	>;

	if (steps.length === 0 && !meta) {
		console.error('Error: no valid trace records found');
		return 1;
	}

	// ── Meta ──────────────────────────────────────────────────────
	if (meta) {
		console.log(`${BOLD}Trace${RESET}: ${meta.name ?? '(unnamed)'}`);
		console.log(`Started: ${meta.started_at ?? '?'}`);
		console.log(`Nodes:   ${meta.total_nodes ?? '?'}`);
		if (meta.base_image) console.log(`Image:   ${meta.base_image}`);
		console.log();
	}

	// ── Group steps by node_path ──────────────────────────────────
	const nodeMap = new Map<string, typeof steps>();
	for (const step of steps) {
		const path = step.node_path ?? '(unknown)';
		if (!nodeMap.has(path)) nodeMap.set(path, []);
		nodeMap.get(path)!.push(step);
	}

	// Sort nodes in DFS order (alphabetical on path segments = DFS for trees)
	const sortedPaths = [...nodeMap.keys()].sort();

	for (const nodePath of sortedPaths) {
		const stepList = nodeMap.get(nodePath)!;
		const failCount = stepList.filter((s) => s.verdict === 'FAIL').length;
		const passCount = stepList.filter((s) => s.verdict === 'PASS').length;
		const nodeVerdict = failCount > 0 ? 'FAIL' : 'PASS';

		if (failuresOnly && nodeVerdict !== 'FAIL') continue;

		// Depth from path segments
		const depth = nodePath === '.' ? 0 : (nodePath.match(/\//g)?.length ?? 0);
		const pad = '  '.repeat(depth);
		const statusStr =
			nodeVerdict === 'PASS'
				? `${GREEN}${BOLD}PASS${RESET}`
				: `${RED}${BOLD}FAIL${RESET}`;
		const reason =
			failCount > 0
				? `${failCount} step${failCount === 1 ? '' : 's'} failed`
				: `${passCount} step${passCount === 1 ? '' : 's'} passed`;

		console.log(
			`${pad}${CYAN}▶${RESET} ${BOLD}${nodePath}${RESET}  ${statusStr}  ${DIM}${reason}${RESET}`,
		);

		// Steps
		for (const step of stepList) {
			if (failuresOnly && step.verdict !== 'FAIL') continue;

			const stepPad = '  '.repeat(depth + 1);
			const mark =
				step.verdict === 'PASS' ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
			const detail = `${DIM}exit ${step.exit_code}${RESET}`;
			const duration =
				step.duration_ms !== undefined
					? ` ${DIM}(${step.duration_ms}ms)${RESET}`
					: '';

		console.log(
			`${stepPad}${mark} step ${step.index + 1}: ${step.command}  ${detail}${duration}`,
		);

		// Judge verdict + reason — always shown
		const verdictColor = step.verdict === 'PASS' ? DIM : RED;
		console.log(`${stepPad}  ${verdictColor}${step.verdict} — ${step.reason}${RESET}`);

		// stdout — always shown when present, ANSI stripped, indented
		const outIndent = stepPad + '    ';
		if (step.stdout) {
			console.log(`${stepPad}  ${DIM}stdout:${RESET}`);
			const clean = step.stdout.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
			if (clean) {
				for (const line of clean.split('\n')) {
					console.log(line ? outIndent + line : '');
				}
			}
		}
		// stderr — always shown when present
		if (step.stderr) {
			console.log(`${stepPad}  ${DIM}stderr:${RESET}`);
			const clean = step.stderr.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
			if (clean) {
				for (const line of clean.split('\n')) {
					console.log(line ? outIndent + line : '');
				}
			}
		}
		console.log();
	}
	}

	// ── Summary ──────────────────────────────────────────────────
	if (summary) {
		console.log();
		const duration =
			summary.duration_ms !== undefined
				? ` ${DIM}(${summary.duration_ms}ms)${RESET}`
				: '';
		const passed = summary.passed as number;
		const failed = summary.failed as number;
		const skipped = summary.skipped as number;
		console.log(
			`${BOLD}Summary${RESET}: ${summary.total ?? '?'} total, ` +
				`${coloredPhrase(passed, 'passed', GREEN)}, ` +
				`${coloredPhrase(failed, 'failed', RED)}, ` +
				`${coloredPhrase(skipped, 'skipped', YELLOW)}${duration}`,
		);
		if (summary.ended_at) {
			console.log(`${DIM}Ended: ${summary.ended_at}${RESET}`);
		}
	}

	// show is a read-only command — always succeeds when it can display the trace,
	// regardless of whether the trace contains failures.
	return 0;
}

export async function runClean(_args: string[]): Promise<number> {
	try {
		const removed = await cleanEphemeralTags();
		if (removed.length === 0) {
			console.log('No ephemeral tags to remove');
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
		const subArgs = args.slice(1);
		if (hasFlag(subArgs, '--help') || hasFlag(subArgs, '-h')) {
			console.log(loadHelp('validate'));
			return 0;
		}
		return runValidate(subArgs);
	}

	if (command === 'run') {
		const subArgs = args.slice(1);
		if (hasFlag(subArgs, '--help') || hasFlag(subArgs, '-h')) {
			console.log(loadHelp('run'));
			return 0;
		}
		return runRun(subArgs);
	}

	if (command === 'tree') {
		const subArgs = args.slice(1);
		if (hasFlag(subArgs, '--help') || hasFlag(subArgs, '-h')) {
			console.log(loadHelp('tree'));
			return 0;
		}
		return runTreeCmd(subArgs);
	}

	if (command === 'lineage') {
		const subArgs = args.slice(1);
		if (hasFlag(subArgs, '--help') || hasFlag(subArgs, '-h')) {
			console.log(loadHelp('lineage'));
			return 0;
		}
		return runLineage(subArgs);
	}

	if (command === 'init') {
		const subArgs = args.slice(1);
		if (hasFlag(subArgs, '--help') || hasFlag(subArgs, '-h')) {
			console.log(loadHelp('init'));
			return 0;
		}
		return runInit(subArgs);
	}

	if (command === 'clean') {
		const subArgs = args.slice(1);
		if (hasFlag(subArgs, '--help') || hasFlag(subArgs, '-h')) {
			console.log(loadHelp('clean'));
			return 0;
		}
		return runClean(subArgs);
	}

	if (command === 'show') {
		const subArgs = args.slice(1);
		if (hasFlag(subArgs, '--help') || hasFlag(subArgs, '-h')) {
			console.log(loadHelp('show'));
			return 0;
		}
		return runShow(subArgs);
	}

	console.error(`Unknown command: ${command}`);
	printHelp();
	return 1;
}
