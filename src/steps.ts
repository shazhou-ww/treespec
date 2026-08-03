/**
 * treespec — Step execution (exec + http)
 *
 * Both exec and http steps run inside the container.
 * HTTP steps use `node -e` to run fetch() inside the container,
 * so localhost reaches services started in the same container
 * — no host network needed.
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

/**
 * Execute an HTTP step inside the container via `node -e`.
 * The fetch() runs in the container's network namespace,
 * so localhost reaches services started in the same container.
 */
export async function executeHttpStep(
	step: HttpStep,
	containerId: string,
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

	// Compact node script: fetch inside container, output JSON to stdout.
	// Variable names are shortened to keep the one-liner compact.
	const script = `const u=${JSON.stringify(url)},m=${JSON.stringify(method)},h=${JSON.stringify(headers)},b=${JSON.stringify(body)},to=${timeoutMs};const c=new AbortController(),tm=setTimeout(()=>c.abort(),to),s=Date.now();fetch(u,{method:m,headers:h,body:(m==="GET"||m==="HEAD")?undefined:b,signal:c.signal}).then(async r=>{const txt=await r.text();const hh={};r.headers.forEach((v,k)=>hh[k.toLowerCase()]=v);process.stdout.write(JSON.stringify({status:r.status,statusText:r.statusText,headers:hh,body:txt,duration_ms:Date.now()-s}))}).catch(e=>{if(c.signal.aborted)process.stdout.write(JSON.stringify({status:0,statusText:"Timeout",headers:{},body:"",duration_ms:Date.now()-s,timedOut:true}));else{process.stderr.write(String(e));process.exit(1)}}).finally(()=>clearTimeout(tm))`;

	// Escape single quotes for /bin/sh -c and run via node -e
	const escaped = script.replace(/'/g, "'\\''");
	const command = `node -e '${escaped}'`;

	const started = Date.now();
	const result: ExecResult = await execInContainer(containerId, command, {
		timeout: timeoutMs,
	});

	// If node itself failed (no stdout), return error
	if (result.exitCode !== 0 && !result.stdout) {
		return {
			status: 0,
			statusText: result.stderr?.trim() || `exit ${result.exitCode}`,
			headers: {},
			body: result.stderr,
			duration_ms: Date.now() - started,
			timedOut: result.timedOut,
		};
	}

	// Parse JSON output from the node script
	try {
		const parsed = JSON.parse(result.stdout);
		return {
			status: parsed.status,
			statusText: parsed.statusText,
			headers: parsed.headers,
			body: parsed.body,
			duration_ms: parsed.duration_ms,
			timedOut: parsed.timedOut,
		};
	} catch {
		return {
			status: 0,
			statusText: 'Parse Error',
			headers: {},
			body: result.stdout,
			duration_ms: Date.now() - started,
		};
	}
}

/**
 * Execute a single step inside `containerId`.
 * Both exec and http steps run inside the container.
 */
export async function executeStep(
	step: Step,
	containerId: string,
	env: Record<string, string>,
): Promise<StepResult> {
	if (step.type === 'http') {
		return executeHttpStep(step, containerId, env);
	}

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
