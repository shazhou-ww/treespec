/**
 * treespec — Assertion evaluation (regex + jsonata + llm)
 */

import jsonata from 'jsonata';
import type { LlmConfig } from './config.js';
import {
	assembleJudgeMessages,
	callLlmApi,
	parseJudgeResponse,
} from './llm.js';
import { isHttpStepResult, type StepResult } from './steps.js';
import type { Assertion, Spec, Step } from './types.js';

export interface JudgeResult {
	verdict: 'PASS' | 'FAIL';
	reason: string;
}

/** Extra context required for LLM assertions. */
export interface AssertContext {
	spec: Spec;
	/** Steps being judged (spec.steps or a postcon's steps). */
	steps: Step[];
	/** Step results including the current step at `currentIndex`. */
	stepResults: StepResult[];
	currentIndex: number;
	llmConfig?: LlmConfig;
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
	// Normalize header lookup: headers.Foo → headers.foo
	if (
		raw.headers !== null &&
		typeof raw.headers === 'object' &&
		!Array.isArray(raw.headers)
	) {
		const normalized: Record<string, string> = {};
		for (const [key, value] of Object.entries(raw.headers as Record<string, unknown>)) {
			normalized[key.toLowerCase()] = String(value);
		}
		raw.headers = normalized;
	}
	return raw;
}

/**
 * Build the object JSONata evaluates against.
 * If stdout/body is a JSON object, its fields are merged so expressions like `a = 1` work.
 */
function jsonataInput(data: Record<string, unknown>): Record<string, unknown> {
	let result = data;

	for (const field of ['stdout', 'body'] as const) {
		const value = result[field];
		if (typeof value !== 'string') continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
				result = { ...(parsed as Record<string, unknown>), ...result };
			}
		} catch {
			// field is not JSON — keep raw result object
		}
	}

	return result;
}

function isHttpLike(data: Record<string, unknown>): boolean {
	return 'status' in data && !('exit_code' in data);
}

/**
 * Evaluate an assertion against a step result object.
 * If `assertion` is undefined:
 *   - exec transition: exit_code 0 = PASS
 *   - http transition: HTTP 2xx = PASS
 * `ctx` is required when `assertion.type === 'llm'`.
 */
export async function evaluateAssertion(
	assertion: Assertion | undefined,
	result: StepResult | Record<string, unknown>,
	ctx?: AssertContext,
): Promise<JudgeResult> {
	const data = normalizeResult(result);
	const httpLike = isHttpStepResult(result as StepResult) || isHttpLike(data);

	if (assertion === undefined) {
		if (httpLike) {
			const status = Number(data.status ?? 0);
			if (status >= 200 && status < 300) {
				return { verdict: 'PASS', reason: `transition step: HTTP ${status}` };
			}
			return { verdict: 'FAIL', reason: `transition step: HTTP ${status}` };
		}
		const code = Number(data.exit_code ?? 1);
		if (code === 0) {
			return { verdict: 'PASS', reason: 'transition step: exit code 0' };
		}
		return { verdict: 'FAIL', reason: `transition step: exit code ${code}` };
	}

	if (assertion.type === 'llm') {
		if (!ctx?.llmConfig) {
			throw new Error('LLM assertion requires TREESPEC_LLM_* env vars');
		}
		try {
			const messages = assembleJudgeMessages(
				ctx.spec,
				ctx.stepResults,
				ctx.currentIndex,
				ctx.steps,
			);
			const response = await callLlmApi(messages, ctx.llmConfig);
			return parseJudgeResponse(response);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { verdict: 'FAIL', reason: message };
		}
	}

	if (assertion.type === 'regex') {
		const failures: string[] = [];
		for (const condition of assertion.conditions) {
			let path = condition.path;
			// headers.<Name> — match case-insensitively via normalized headers
			if (path.toLowerCase().startsWith('headers.')) {
				const name = path.slice('headers.'.length).toLowerCase();
				path = `headers.${name}`;
			}
			const value = resolvePath(data, path);
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
