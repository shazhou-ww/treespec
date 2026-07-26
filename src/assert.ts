/**
 * treespec — Assertion evaluation (regex + jsonata in Phase 3)
 */

import jsonata from 'jsonata';
import type { StepResult } from './steps.js';
import type { Assertion } from './types.js';

export interface JudgeResult {
	verdict: 'PASS' | 'FAIL';
	reason: string;
}

function resolvePath(result: Record<string, unknown>, path: string): unknown {
	if (Object.prototype.hasOwnProperty.call(result, path)) {
		return result[path];
	}
	const parts = path.split('.');
	let cur: unknown = result;
	for (const part of parts) {
		if (cur === null || cur === undefined || typeof cur !== 'object') {
			return undefined;
		}
		cur = (cur as Record<string, unknown>)[part];
	}
	return cur;
}

function toMatchString(value: unknown): string {
	if (value === undefined || value === null) return '';
	return String(value);
}

function normalizeResult(result: StepResult | Record<string, unknown>): Record<string, unknown> {
	const raw = { ...(result as Record<string, unknown>) };
	if ('exitCode' in raw && !('exit_code' in raw)) {
		raw.exit_code = raw.exitCode;
	}
	return raw;
}

/**
 * Build the object JSONata evaluates against.
 * If stdout is a JSON object, its fields are merged so expressions like `a = 1` work.
 */
function jsonataInput(data: Record<string, unknown>): Record<string, unknown> {
	const stdout = data.stdout;
	if (typeof stdout !== 'string') return data;
	const trimmed = stdout.trim();
	if (!trimmed) return data;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
			return { ...(parsed as Record<string, unknown>), ...data };
		}
	} catch {
		// stdout is not JSON — evaluate against the raw result object
	}
	return data;
}

/**
 * Evaluate an assertion against a step result object.
 * If `assertion` is undefined, treat as transition: exit_code 0 = PASS.
 */
export async function evaluateAssertion(
	assertion: Assertion | undefined,
	result: StepResult | Record<string, unknown>,
): Promise<JudgeResult> {
	const data = normalizeResult(result);

	if (assertion === undefined) {
		const code = Number(data.exit_code ?? 1);
		if (code === 0) {
			return { verdict: 'PASS', reason: 'transition step: exit code 0' };
		}
		return { verdict: 'FAIL', reason: `transition step: exit code ${code}` };
	}

	if (assertion.type === 'llm') {
		throw new Error('LLM assertion not yet supported');
	}

	if (assertion.type === 'regex') {
		const failures: string[] = [];
		for (const condition of assertion.conditions) {
			const value = resolvePath(data, condition.path);
			const text = toMatchString(value);
			let re: RegExp;
			try {
				re = new RegExp(condition.regex);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					verdict: 'FAIL',
					reason: `invalid regex for ${condition.path}: ${message}`,
				};
			}
			if (!re.test(text)) {
				failures.push(
					`${condition.path} did not match /${condition.regex}/ (got ${JSON.stringify(text)})`,
				);
			}
		}
		if (failures.length === 0) {
			return { verdict: 'PASS', reason: 'all regex conditions matched' };
		}
		return { verdict: 'FAIL', reason: failures.join('; ') };
	}

	if (assertion.type === 'jsonata') {
		try {
			const expr = jsonata(assertion.expression);
			const value = await expr.evaluate(jsonataInput(data));
			if (value) {
				return { verdict: 'PASS', reason: `jsonata evaluated to ${JSON.stringify(value)}` };
			}
			return {
				verdict: 'FAIL',
				reason: `jsonata evaluated to ${JSON.stringify(value)}`,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { verdict: 'FAIL', reason: `jsonata error: ${message}` };
		}
	}

	const _exhaustive: never = assertion;
	return { verdict: 'FAIL', reason: `unknown assertion type: ${JSON.stringify(_exhaustive)}` };
}
