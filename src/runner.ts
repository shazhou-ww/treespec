/**
 * treespec — Single-node runner (Phase 3: no commit, no DFS, no postcon)
 */

import { evaluateAssertion } from './assert.js';
import {
	createAndStartContainer,
	removeContainer,
} from './executor.js';
import { executeStep, type StepResult } from './steps.js';
import type { TreeNode } from './scanner.js';

export interface NodeResult {
	status: 'PASS' | 'FAIL' | 'SKIP';
	reason: string;
	stepResults: StepResult[];
}

export interface RunNodeOptions {
	/** Optional callback after each step is judged. */
	onStep?: (info: {
		index: number;
		stepSummary: string;
		stepResult: StepResult;
		verdict: 'PASS' | 'FAIL';
		reason: string;
	}) => void;
}

/**
 * Run a single tree node against `parentTag`.
 * Organizational nodes pass through without executing steps.
 */
export async function runNode(
	node: TreeNode,
	parentTag: string,
	env: Record<string, string>,
	options: RunNodeOptions = {},
): Promise<NodeResult> {
	if (!node.spec) {
		return {
			status: 'PASS',
			reason: 'organizational node (pass-through)',
			stepResults: [],
		};
	}

	const spec = node.spec;

	for (const varName of spec.env ?? []) {
		const value = env[varName];
		if (value === undefined || value === '') {
			return {
				status: 'SKIP',
				reason: `missing env: ${varName}`,
				stepResults: [],
			};
		}
	}

	let containerId: string | undefined;
	const stepResults: StepResult[] = [];

	try {
		containerId = await createAndStartContainer(parentTag, env);

		for (let i = 0; i < spec.steps.length; i++) {
			const step = spec.steps[i]!;
			const stepResult = await executeStep(step, containerId, env);
			stepResults.push(stepResult);

			if (stepResult.timedOut) {
				const reason = `step ${i + 1} timed out`;
				options.onStep?.({
					index: i,
					stepSummary: step.type === 'exec' ? step.command : 'http',
					stepResult,
					verdict: 'FAIL',
					reason,
				});
				return { status: 'FAIL', reason, stepResults };
			}

			const judge = await evaluateAssertion(step.assert, stepResult);
			const stepSummary = step.type === 'exec' ? step.command : 'http';
			options.onStep?.({
				index: i,
				stepSummary,
				stepResult,
				verdict: judge.verdict,
				reason: judge.reason,
			});

			if (judge.verdict === 'FAIL') {
				return {
					status: 'FAIL',
					reason: `step ${i + 1} failed: ${judge.reason}`,
					stepResults,
				};
			}
		}

		return {
			status: 'PASS',
			reason: `${spec.steps.length} step${spec.steps.length === 1 ? '' : 's'} passed`,
			stepResults,
		};
	} finally {
		if (containerId) {
			await removeContainer(containerId);
		}
	}
}
