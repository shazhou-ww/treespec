/**
 * treespec — CLI commands
 */

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseConfig } from './schema.js';
import { countNodes, formatForest, scanSpecs } from './scanner.js';

export function printHelp(): void {
	console.log(`treespec — tree-structured, stateful test system

Usage:
  treespec validate [--config <path>]   Validate treespec.yaml and the test tree
  treespec help                         Show this help

Options:
  --config <path>   Path to treespec.yaml (default: ./treespec.yaml)
`);
}

function getFlagValue(args: string[], name: string): string | undefined {
	const idx = args.indexOf(name);
	if (idx === -1) return undefined;
	return args[idx + 1];
}

export async function runValidate(args: string[]): Promise<number> {
	const configFlag = getFlagValue(args, '--config');
	const configPath = resolve(process.cwd(), configFlag ?? 'treespec.yaml');
	const configDir = dirname(configPath);

	let configYaml: string;
	try {
		configYaml = await readFile(configPath, 'utf8');
	} catch {
		console.error(`Error: cannot read config file: ${configPath}`);
		return 1;
	}

	let config;
	try {
		config = parseConfig(configYaml);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error(`Error: invalid treespec.yaml: ${message}`);
		return 1;
	}

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

	console.error(`Unknown command: ${command}`);
	printHelp();
	return 1;
}
