/**
 * treespec — Tree DFS runner (commit + postcon + failure pruning)
 */

import { evaluateAssertion } from './assert.js';
import {
	commitContainer,
	ephemeralTagForPath,
	removeImage,
} from './docker.js';
import {
	createAndStartContainer,
	removeContainer,
} from './executor.js';
import type { TreeNode } from './scanner.js';
import { executeStep, type StepResult } from './steps.js';
import type { Assertion, Step } from './types.js';

export interface NodeResult {
	status: 'PASS' | 'FAIL' | 'SKIP';
	reason: string;
	stepResults: StepResult[];
}

export interface RunConfig {
	keepTags: boolean;
	output?: string;
	/** Absolute path to the specs root (mounted read-only at /specs). */
	specsDir: string;
	onNode?: (info: {
		node: TreeNode;
		result: NodeResult;
		depth: number;
	}) => void;
	onStep?: (info: {
		node: TreeNode;
		depth: number;
		index: number;
		stepSummary: string;
		stepResult: StepResult;
		verdict: 'PASS' | 'FAIL';
		reason: string;
		context: 'step' | 'postcon';
		postconName?: string;
	}) => void;
}

export interface RunSummary {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	results: Array<{ node: TreeNode; result: NodeResult; depth: number }>;
}

function record(
	summary: RunSummary,
	node: TreeNode,
	result: NodeResult,
	depth: number,
	config: RunConfig,
): void {
	summary.total++;
	if (result.status === 'PASS') summary.passed++;
	else if (result.status === 'FAIL') summary.failed++;
	else summary.skipped++;
	summary.results.push({ node, result, depth });
	config.onNode?.({ node, result, depth });
}

/**
 * Mark a node and its entire subtree as SKIPPED (failure / env prune).
 */
function cascadeSkip(
	node: TreeNode,
	reason: string,
	config: RunConfig,
	depth: number,
	summary: RunSummary,
): void {
	const result: NodeResult = {
		status: 'SKIP',
		reason,
		stepResults: [],
	};
	record(summary, node, result, depth, config);
	for (const child of node.children) {
		cascadeSkip(child, 'parent skipped', config, depth + 1, summary);
	}
}

async function runSteps(
	steps: Step[],
	containerId: string,
	env: Record<string, string>,
	node: TreeNode,
	depth: number,
	config: RunConfig,
	context: 'step' | 'postcon',
	postconName?: string,
): Promise<{ ok: true; stepResults: StepResult[] } | { ok: false; reason: string; stepResults: StepResult[] }> {
	const stepResults: StepResult[] = [];

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]!;
		const stepResult = await executeStep(step, containerId, env);
		stepResults.push(stepResult);

		const stepSummary = step.type === 'exec' ? step.command : 'http';

		if (stepResult.timedOut) {
			const reason = context === 'postcon'
				? `postcon ${postconName}: step ${i + 1} timed out`
				: `step ${i + 1} timed out`;
			config.onStep?.({
				node,
				depth,
				index: i,
				stepSummary,
				stepResult,
				verdict: 'FAIL',
				reason,
				context,
				postconName,
			});
			return { ok: false, reason, stepResults };
		}

		const judge = await evaluateAssertion(step.assert as Assertion | undefined, stepResult);
		config.onStep?.({
			node,
			depth,
			index: i,
			stepSummary,
			stepResult,
			verdict: judge.verdict,
			reason: judge.reason,
			context,
			postconName,
		});

		if (judge.verdict === 'FAIL') {
			const reason = context === 'postcon'
				? `postcon ${postconName}: step ${i + 1} failed: ${judge.reason}`
				: `step ${i + 1} failed: ${judge.reason}`;
			return { ok: false, reason, stepResults };
		}
	}

	return { ok: true, stepResults };
}

/**
 * DFS-execute a tree node against `parentTag`.
 * Organizational nodes pass `parentTag` through to children (no steps / commit).
 */
export async function runTree(
	node: TreeNode,
	parentTag: string,
	env: Record<string, string>,
	config: RunConfig,
	depth = 0,
	summary: RunSummary = { total: 0, passed: 0, failed: 0, skipped: 0, results: [] },
): Promise<{ result: NodeResult; summary: RunSummary }> {
	// ── Organizational node: pass-through ──────────────────────────
	if (!node.spec) {
		const result: NodeResult = {
			status: 'PASS',
			reason: 'organizational node (pass-through)',
			stepResults: [],
		};
		record(summary, node, result, depth, config);
		for (const child of node.children) {
			await runTree(child, parentTag, env, config, depth + 1, summary);
		}
		return { result, summary };
	}

	const spec = node.spec;

	// ── Env check ──────────────────────────────────────────────────
	for (const varName of spec.env ?? []) {
		const value = env[varName];
		if (value === undefined || value === '') {
			const result: NodeResult = {
				status: 'SKIP',
				reason: `missing env: ${varName}`,
				stepResults: [],
			};
			record(summary, node, result, depth, config);
			for (const child of node.children) {
				cascadeSkip(child, 'parent skipped', config, depth + 1, summary);
			}
			return { result, summary };
		}
	}

	let containerId: string | undefined;
	let ephemeralTag: string | undefined;
	let committed = false;
	const stepResults: StepResult[] = [];

	try {
		containerId = await createAndStartContainer(parentTag, {
			env,
			specsDir: config.specsDir,
			workdir: node.path,
		});

		// ── Steps ────────────────────────────────────────────────────
		const stepsOutcome = await runSteps(
			spec.steps,
			containerId,
			env,
			node,
			depth,
			config,
			'step',
		);
		stepResults.push(...stepsOutcome.stepResults);

		if (!stepsOutcome.ok) {
			const result: NodeResult = {
				status: 'FAIL',
				reason: stepsOutcome.reason,
				stepResults,
			};
			record(summary, node, result, depth, config);
			for (const child of node.children) {
				cascadeSkip(child, 'parent skipped', config, depth + 1, summary);
			}
			return { result, summary };
		}

		const hasChildren = node.children.length > 0;
		const hasPostcon = (spec.postcon?.length ?? 0) > 0;
		const needCommit = hasChildren || hasPostcon;

		// ── Commit ───────────────────────────────────────────────────
		if (needCommit) {
			ephemeralTag = ephemeralTagForPath(node.path);
			await commitContainer(containerId, ephemeralTag);
			committed = true;
		}

		// ── Postcon ──────────────────────────────────────────────────
		if (hasPostcon && ephemeralTag) {
			for (const postcon of spec.postcon!) {
				let postconId: string | undefined;
				try {
					postconId = await createAndStartContainer(ephemeralTag, {
						env,
						specsDir: config.specsDir,
						workdir: node.path,
					});
					const postconOutcome = await runSteps(
						postcon.steps,
						postconId,
						env,
						node,
						depth,
						config,
						'postcon',
						postcon.name,
					);
					stepResults.push(...postconOutcome.stepResults);
					if (!postconOutcome.ok) {
						const result: NodeResult = {
							status: 'FAIL',
							reason: postconOutcome.reason,
							stepResults,
						};
						record(summary, node, result, depth, config);
						for (const child of node.children) {
							cascadeSkip(child, 'parent skipped', config, depth + 1, summary);
						}
						return { result, summary };
					}
				} finally {
					if (postconId) {
						await removeContainer(postconId);
					}
				}
			}
		}

		const result: NodeResult = {
			status: 'PASS',
			reason: `${spec.steps.length} step${spec.steps.length === 1 ? '' : 's'} passed`,
			stepResults,
		};
		record(summary, node, result, depth, config);

		// ── Children (DFS) ───────────────────────────────────────────
		if (hasChildren && ephemeralTag) {
			for (const child of node.children) {
				await runTree(child, ephemeralTag, env, config, depth + 1, summary);
			}
		}

		return { result, summary };
	} finally {
		if (committed && ephemeralTag && !config.keepTags) {
			await removeImage(ephemeralTag);
		}
		if (containerId) {
			await removeContainer(containerId);
		}
	}
}

/**
 * Run a forest of root nodes against the base image tag.
 */
export async function runForest(
	trees: TreeNode[],
	baseTag: string,
	env: Record<string, string>,
	config: RunConfig,
): Promise<RunSummary> {
	const summary: RunSummary = {
		total: 0,
		passed: 0,
		failed: 0,
		skipped: 0,
		results: [],
	};
	for (const root of trees) {
		await runTree(root, baseTag, env, config, 0, summary);
	}
	return summary;
}
