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
import {
	executeStep,
	parseDuration,
	type StepResult,
} from './steps.js';
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function stepSummaryOf(step: Step): string {
	if (step.type === 'exec') return step.command;
	return `${step.request.method.toUpperCase()} ${step.request.url}`;
}

/**
 * Execute one step (possibly with wait polling) and evaluate its assertion.
 * Wait only applies when the step has an assert and that assert fails.
 */
async function executeStepWithAssert(
	step: Step,
	containerId: string,
	env: Record<string, string>,
): Promise<{
	stepResult: StepResult;
	verdict: 'PASS' | 'FAIL';
	reason: string;
	timedOut: boolean;
}> {
	const waitTimeoutMs = step.wait ? parseDuration(step.wait.timeout) : 0;
	const delayMs = step.wait ? parseDuration(step.wait.delay ?? '5s') : 0;
	const started = Date.now();
	let attempts = 0;

	for (;;) {
		attempts++;
		const stepResult = await executeStep(step, containerId, env);

		if (stepResult.timedOut) {
			return {
				stepResult,
				verdict: 'FAIL',
				reason: 'step timed out',
				timedOut: true,
			};
		}

		// Transition steps: immediate pass/fail — wait does nothing
		if (step.assert === undefined) {
			const judge = await evaluateAssertion(undefined, stepResult);
			return {
				stepResult,
				verdict: judge.verdict,
				reason: judge.reason,
				timedOut: false,
			};
		}

		const judge = await evaluateAssertion(step.assert as Assertion, stepResult);
		if (judge.verdict === 'PASS') {
			return {
				stepResult,
				verdict: 'PASS',
				reason: judge.reason,
				timedOut: false,
			};
		}

		// No wait configured → fail immediately
		if (!step.wait) {
			return {
				stepResult,
				verdict: 'FAIL',
				reason: judge.reason,
				timedOut: false,
			};
		}

		const elapsed = Date.now() - started;
		if (elapsed >= waitTimeoutMs) {
			return {
				stepResult,
				verdict: 'FAIL',
				reason: `wait timeout exceeded after ${attempts} attempts`,
				timedOut: false,
			};
		}

		await sleep(delayMs);

		if (Date.now() - started >= waitTimeoutMs) {
			return {
				stepResult,
				verdict: 'FAIL',
				reason: `wait timeout exceeded after ${attempts} attempts`,
				timedOut: false,
			};
		}
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
		const stepSummary = stepSummaryOf(step);
		const outcome = await executeStepWithAssert(step, containerId, env);
		stepResults.push(outcome.stepResult);

		if (outcome.timedOut) {
			const reason = context === 'postcon'
				? `postcon ${postconName}: step ${i + 1} timed out`
				: `step ${i + 1} timed out`;
			config.onStep?.({
				node,
				depth,
				index: i,
				stepSummary,
				stepResult: outcome.stepResult,
				verdict: 'FAIL',
				reason,
				context,
				postconName,
			});
			return { ok: false, reason, stepResults };
		}

		config.onStep?.({
			node,
			depth,
			index: i,
			stepSummary,
			stepResult: outcome.stepResult,
			verdict: outcome.verdict,
			reason: outcome.reason,
			context,
			postconName,
		});

		if (outcome.verdict === 'FAIL') {
			const reason = context === 'postcon'
				? `postcon ${postconName}: step ${i + 1} failed: ${outcome.reason}`
				: `step ${i + 1} failed: ${outcome.reason}`;
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

	const needsContainer =
		spec.steps.some((s) => s.type === 'exec') ||
		(spec.postcon?.some((p) => p.steps.some((s) => s.type === 'exec')) ?? false) ||
		node.children.length > 0 ||
		(spec.postcon?.length ?? 0) > 0;

	try {
		if (needsContainer) {
			containerId = await createAndStartContainer(parentTag, {
				env,
				specsDir: config.specsDir,
				workdir: node.path,
			});
		}

		// ── Steps ────────────────────────────────────────────────────
		// HTTP-only cases may have no container; executeStep ignores containerId for http.
		const stepsOutcome = await runSteps(
			spec.steps,
			containerId ?? '',
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
		if (needCommit && containerId) {
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
