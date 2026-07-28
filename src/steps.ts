/**
 * treespec — Step execution (exec + http)
 */

import { substituteVars } from './env.js';
import { execInContainer, type ExecResult } from './executor.js';
import type { HttpStep, Step } from './types.js';

export interface ExecStepResult {
	stdout: string;
	stderr: string;
	exit_code: number;
	timedOut?: boolean;
}

export interface HttpStepResult {
	status: number;
	statusText: string;
	headers: Record<string, string>;
	body: string;
	duration_ms: number;
	timedOut?: boolean;
}

export type StepResult = ExecStepResult | HttpStepResult;

export function isHttpStepResult(result: StepResult): result is HttpStepResult {
	return 'status' in result && 'body' in result && !('exit_code' in result);
}

export function isExecStepResult(result: StepResult): result is ExecStepResult {
	return 'exit_code' in result;
}

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
 * Recursively substitute `$VAR` / `${VAR}` in string values.
 */
export function substituteDeep(value: unknown, env: Record<string, string>): unknown {
	if (typeof value === 'string') {
		return substituteVars(value, env);
	}
	if (Array.isArray(value)) {
		return value.map((item) => substituteDeep(item, env));
	}
	if (value !== null && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
			out[key] = substituteDeep(child, env);
		}
		return out;
	}
	return value;
}

function headersToRecord(headers: Headers): Record<string, string> {
	const out: Record<string, string> = {};
	headers.forEach((value, key) => {
		out[key.toLowerCase()] = value;
	});
	return out;
}

/**
 * Execute an HTTP step from the host (not inside a container).
 */
export async function executeHttpStep(
	step: HttpStep,
	env: Record<string, string>,
): Promise<HttpStepResult> {
	const url = substituteVars(step.request.url, env);
	const method = step.request.method.toUpperCase();

	const headers: Record<string, string> = {};
	if (step.request.headers) {
		for (const [key, value] of Object.entries(step.request.headers)) {
			headers[key] = substituteVars(value, env);
		}
	}

	let body: string | undefined;
	if (step.request.body !== undefined) {
		const substituted = substituteDeep(step.request.body, env);
		if (typeof substituted === 'string') {
			body = substituted;
		} else {
			body = JSON.stringify(substituted);
			const hasContentType = Object.keys(headers).some(
				(k) => k.toLowerCase() === 'content-type',
			);
			if (!hasContentType) {
				headers['Content-Type'] = 'application/json';
			}
		}
	}

	const timeoutMs = parseDuration(step.timeout ?? '30s');
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const started = Date.now();

	try {
		const response = await fetch(url, {
			method,
			headers,
			body: method === 'GET' || method === 'HEAD' ? undefined : body,
			signal: controller.signal,
		});
		const responseBody = await response.text();
		return {
			status: response.status,
			statusText: response.statusText,
			headers: headersToRecord(response.headers),
			body: responseBody,
			duration_ms: Date.now() - started,
			timedOut: false,
		};
	} catch (err) {
		const aborted =
			(err instanceof Error && err.name === 'AbortError') ||
			controller.signal.aborted;
		if (aborted) {
			return {
				status: 0,
				statusText: 'Timeout',
				headers: {},
				body: '',
				duration_ms: Date.now() - started,
				timedOut: true,
			};
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Execute a single step. Exec steps run inside `containerId`;
 * HTTP steps run from the host via fetch().
 */
export async function executeStep(
	step: Step,
	containerId: string,
	env: Record<string, string>,
): Promise<StepResult> {
	if (step.type === 'http') {
		return executeHttpStep(step, env);
	}

	const command = substituteVars(step.command, env);
	const timeoutMs = parseDuration(step.timeout ?? '30s');

	const result: ExecResult = await execInContainer(containerId, command, {
		timeout: timeoutMs,
	});

	return {
		stdout: result.stdout,
		stderr: result.stderr,
		exit_code: result.exitCode,
		timedOut: result.timedOut,
	};
}
