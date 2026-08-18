/**
 * treespec — Step execution (exec only)
 *
 * All steps run inside the container via `docker exec`.
 * For HTTP testing, use `curl` within exec steps — shell variables
 * naturally enable inter-request value passing.
 */

import { substituteVars } from './env.js';
import { execInContainer, type ExecResult } from './executor.js';
import type { Step } from './types.js';

export interface StepResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	timedOut?: boolean;
}

/** @deprecated Use StepResult instead. Kept for backward compat. */
export type ExecStepResult = StepResult;

/**
 * Parse a duration string like `30s`, `2m`, `1h` into milliseconds.
 */
export function parseDuration(input: string): number {
	const match = /^(\d+(?:\.\d+)?)(s|m|h)$/i.exec(input.trim());
	if (!match) {
		throw new Error(`Invalid duration: ${input} (expected e.g. 30s, 2m, 1h)`);
	}
	const value = Number(match[1]);
	const unit = match[2]!.toLowerCase();
	if (unit === 's') return Math.round(value * 1000);
	if (unit === 'm') return Math.round(value * 60_000);
	return Math.round(value * 3_600_000);
}

/**
 * Execute a single step inside `containerId`.
 */
export async function executeStep(
	step: Step,
	containerId: string,
	env: Record<string, string>,
): Promise<StepResult> {
	const command = substituteVars(step.command, env);
	const timeoutMs = parseDuration(step.timeout ?? '30s');

	const result: ExecResult = await execInContainer(containerId, command, {
		timeout: timeoutMs,
		...(step.cwd ? { cwd: step.cwd } : {}),
	});

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exit_code: result.exitCode,
		timedOut: result.timedOut,
	};
}
