/**
 * treespec — Tree DFS runner (commit + postcon + failure pruning)
 */

import type { LlmConfig } from './config.js';
import { evaluateAssertion, type AssertContext } from './assert.js';
import {
	commitContainer,
	ephemeralTagForPath,
	removeImage,
} from './docker.js';
import {
	createAndStartContainer,
	removeContainer,
} from './executor.js';
import { countNodes, allChildren, type TreeNode } from './scanner.js';
import {
	executeStep,
	isExecStepResult,
	parseDuration,
	type StepResult,
} from './steps.js';
import type { TraceWriter } from './trace.js';
import type { Assertion, Spec, Step } from './types.js';

export interface NodeResult {
	status: 'PASS' | 'FAIL' | 'SKIP';
	reason: string;
	stepResults: StepResult[];
}

export interface RunConfig {
	keepTags: boolean;
	output?: string;
	/** Absolute path to project root (container-internal in DinD). Mounted at /app:ro. */
	projectDir: string;
	/** Spec directory relative to projectDir (e.g. "spec"). Used for container WORKDIR. */
	specRelative: string;
	/** When false, skip JSONL trace writes. Default true when trace is set. */
	writeTrace?: boolean;
	/** Trace writer (created by CLI). */
	trace?: TraceWriter;
	/** LLM config for llm assertions (optional). */
	llm?: LlmConfig;
	/** Base image tag (written into trace meta). */
	baseImage?: string;
	/** Docker network mode (e.g. "host", "bridge"). */
	network?: string;
	/** Extra host entries (same format as docker --add-host). */
	extraHosts?: string[];
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
		duration_ms: number;
	}) => void;
}

export interface RunSummary {
	total: number;
	passed: number;
	failed: number;
	skipped: number;
	results: Array<{ node: TreeNode; result: NodeResult; depth: number }>;
	duration_ms?: number;
}

function stepsUseLlm(steps: Step[]): boolean {
	return steps.some((s) => s.assert?.type === 'llm');
}

function specUsesLlm(spec: Spec): boolean {
	if (stepsUseLlm(spec.steps)) return true;
	return spec.postcon?.some((p) => stepsUseLlm(p.steps)) ?? false;
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
	for (const child of allChildren(node)) {
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

function stepFieldsForTrace(stepResult: StepResult): {
	stdout: string;
	stderr: string;
	exit_code: number;
} {
	if (isExecStepResult(stepResult)) {
		return {
			stdout: stepResult.stdout,
			stderr: stepResult.stderr,
			exit_code: stepResult.exit_code,
		};
	}
	return {
		stdout: stepResult.body,
		stderr: '',
		exit_code: stepResult.status,
	};
}

async function emitStepTrace(
	config: RunConfig,
	node: TreeNode,
	index: number,
	command: string,
	stepResult: StepResult,
	verdict: 'PASS' | 'FAIL',
	reason: string,
	duration_ms: number,
): Promise<void> {
	if (config.writeTrace === false || !config.trace) return;
	const fields = stepFieldsForTrace(stepResult);
	await config.trace.writeStep({
		index,
		step_index: index,
		node_path: node.path,
		command,
		stdout: fields.stdout,
		stderr: fields.stderr,
		exit_code: fields.exit_code,
		verdict,
		reason,
		duration_ms,
	});
}

/**
 * Execute one step (possibly with wait polling) and evaluate its assertion.
 * Wait only applies when the step has an assert and that assert fails.
 */
async function executeStepWithAssert(
	step: Step,
	containerId: string,
	env: Record<string, string>,
	assertCtx: Omit<AssertContext, 'stepResults'> & { stepResults: StepResult[] },
): Promise<{
	stepResult: StepResult;
	verdict: 'PASS' | 'FAIL';
	reason: string;
	timedOut: boolean;
	duration_ms: number;
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
				duration_ms: Date.now() - started,
			};
		}

		const ctx: AssertContext = {
			...assertCtx,
			stepResults: [...assertCtx.stepResults, stepResult],
		};

		// Transition steps: immediate pass/fail — wait does nothing
		if (step.assert === undefined) {
			const judge = await evaluateAssertion(undefined, stepResult, ctx);
			return {
				stepResult,
				verdict: judge.verdict,
				reason: judge.reason,
				timedOut: false,
				duration_ms: Date.now() - started,
			};
		}

		const judge = await evaluateAssertion(step.assert as Assertion, stepResult, ctx);
		if (judge.verdict === 'PASS') {
			return {
				stepResult,
				verdict: 'PASS',
				reason: judge.reason,
				timedOut: false,
				duration_ms: Date.now() - started,
			};
		}

		// No wait configured → fail immediately
		if (!step.wait) {
			return {
				stepResult,
				verdict: 'FAIL',
				reason: judge.reason,
				timedOut: false,
				duration_ms: Date.now() - started,
			};
		}

		const elapsed = Date.now() - started;
		if (elapsed >= waitTimeoutMs) {
			return {
				stepResult,
				verdict: 'FAIL',
				reason: `wait timeout exceeded after ${attempts} attempts`,
				timedOut: false,
				duration_ms: Date.now() - started,
			};
		}

		await sleep(delayMs);

		if (Date.now() - started >= waitTimeoutMs) {
			return {
				stepResult,
				verdict: 'FAIL',
				reason: `wait timeout exceeded after ${attempts} attempts`,
				timedOut: false,
				duration_ms: Date.now() - started,
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
	spec: Spec,
	postconName?: string,
): Promise<{ ok: true; stepResults: StepResult[] } | { ok: false; reason: string; stepResults: StepResult[] }> {
	const stepResults: StepResult[] = [];

	for (let i = 0; i < steps.length; i++) {
		const step = steps[i]!;
		const stepSummary = stepSummaryOf(step);
		const assertCtx = {
			spec,
			steps,
			stepResults,
			currentIndex: i,
			llmConfig: config.llm,
		};
		const outcome = await executeStepWithAssert(step, containerId, env, assertCtx);
		stepResults.push(outcome.stepResult);

		config.onStep?.({
			node,
			depth,
			index: i,
			stepSummary,
			stepResult: outcome.stepResult,
			verdict: outcome.verdict,
			reason: outcome.timedOut
				? (context === 'postcon'
					? `postcon ${postconName}: step ${i + 1} timed out`
					: `step ${i + 1} timed out`)
				: outcome.reason,
			context,
			postconName,
			duration_ms: outcome.duration_ms,
		});

		await emitStepTrace(
			config,
			node,
			i,
			stepSummary,
			outcome.stepResult,
			outcome.verdict,
			outcome.reason,
			outcome.duration_ms,
		);

		if (outcome.timedOut) {
			const reason = context === 'postcon'
				? `postcon ${postconName}: step ${i + 1} timed out`
				: `step ${i + 1} timed out`;
			return { ok: false, reason, stepResults };
		}

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
 */
export async function runTree(
	node: TreeNode,
	parentTag: string,
	env: Record<string, string>,
	config: RunConfig,
	depth = 0,
	summary: RunSummary = { total: 0, passed: 0, failed: 0, skipped: 0, results: [] },
): Promise<{ result: NodeResult; summary: RunSummary }> {
	const spec = node.spec;

	// Container/passthrough node: no steps and no postcon → pass parentTag directly to children
	const isPassthrough = spec.steps.length === 0 && (spec.postcon?.length ?? 0) === 0;

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
			for (const child of allChildren(node)) {
				cascadeSkip(child, 'parent skipped', config, depth + 1, summary);
			}
			return { result, summary };
		}
	}

	// ── LLM config check ───────────────────────────────────────────
	if (specUsesLlm(spec) && !config.llm) {
		const result: NodeResult = {
			status: 'SKIP',
			reason: 'no LLM config',
			stepResults: [],
		};
		record(summary, node, result, depth, config);
		for (const child of allChildren(node)) {
			cascadeSkip(child, 'parent skipped', config, depth + 1, summary);
		}
		return { result, summary };
	}

	let containerId: string | undefined;
	let ephemeralTag: string | undefined;
	let committed = false;
	const stepResults: StepResult[] = [];

	const needsContainer = !isPassthrough && (
		spec.steps.some((s) => s.type === 'exec') ||
		(spec.postcon?.some((p) => p.steps.some((s) => s.type === 'exec')) ?? false) ||
		(spec.postcon?.length ?? 0) > 0
	);

	try {
		if (needsContainer) {
			containerId = await createAndStartContainer(parentTag, {
				env,
			projectDir: config.projectDir,
			specRelative: config.specRelative,
			workdir: node.path,
			network: config.network,
			extraHosts: config.extraHosts,
		});
		}

		// ── Steps ────────────────────────────────────────────────────
		const stepsOutcome = await runSteps(
			spec.steps,
			containerId ?? '',
			env,
			node,
			depth,
			config,
			'step',
			spec,
		);
		stepResults.push(...stepsOutcome.stepResults);

		if (!stepsOutcome.ok) {
			const result: NodeResult = {
				status: 'FAIL',
				reason: stepsOutcome.reason,
				stepResults,
			};
			record(summary, node, result, depth, config);
			for (const child of allChildren(node)) {
				cascadeSkip(child, 'parent skipped', config, depth + 1, summary);
			}
			return { result, summary };
		}

		const hasChildren = allChildren(node).length > 0;
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
			projectDir: config.projectDir,
			specRelative: config.specRelative,
			workdir: node.path,
			network: config.network,
			extraHosts: config.extraHosts,
		});
					const postconSpec: Spec = {
						description: `${spec.description ?? node.path} / postcon ${postcon.name}`,
						steps: postcon.steps,
					};
					const postconOutcome = await runSteps(
						postcon.steps,
						postconId,
						env,
						node,
						depth,
						config,
						'postcon',
						postconSpec,
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
						for (const child of allChildren(node)) {
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
			reason: isPassthrough
				? 'container node (passthrough)'
				: `${spec.steps.length} step${spec.steps.length === 1 ? '' : 's'} passed`,
			stepResults,
		};
		record(summary, node, result, depth, config);

		// ── Children (DFS) ───────────────────────────────────────────
		// Passthrough nodes pass parentTag directly; committed nodes pass their ephemeral tag.
		const childTag = ephemeralTag ?? parentTag;
		if (hasChildren && childTag) {
			for (const child of allChildren(node)) {
				await runTree(child, childTag, env, config, depth + 1, summary);
			}
		}

		return { result, summary };
	} finally {
		// Best-effort cleanup — ignore errors if tags/containers were already removed
		// (e.g. by `treespec clean` running inside a child test).
		if (committed && ephemeralTag && !config.keepTags) {
			try { await removeImage(ephemeralTag); } catch { /* already gone */ }
		}
		if (containerId) {
			try { await removeContainer(containerId); } catch { /* already gone */ }
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
	const started = Date.now();
	const totalNodes = countNodes(trees);

	if (config.writeTrace !== false && config.trace) {
		// Build tree structure for lineage computation in `show`
		const roots = trees.map((t) => t.path);
		const primaryMap: Record<string, string> = {};
		function walkPrimary(node: TreeNode): void {
			if (node.primary) {
				primaryMap[node.path] = node.primary.path;
				walkPrimary(node.primary);
			}
			for (const branch of node.branches) {
				walkPrimary(branch);
			}
		}
		for (const root of trees) walkPrimary(root);

		await config.trace.writeMeta(totalNodes, {
			name: 'treespec run',
			base_image: config.baseImage,
			roots,
			primary_map: primaryMap,
		});
	}

	for (const root of trees) {
		await runTree(root, baseTag, env, config, 0, summary);
	}

	summary.duration_ms = Date.now() - started;

	if (config.writeTrace !== false && config.trace) {
		await config.trace.writeSummary({
			total: summary.total,
			passed: summary.passed,
			failed: summary.failed,
			skipped: summary.skipped,
			duration_ms: summary.duration_ms,
			ended_at: new Date().toISOString(),
		});
	}

	return summary;
}
