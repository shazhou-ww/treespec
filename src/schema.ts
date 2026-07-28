/**
 * treespec — Zod schemas + parse helpers for spec.yaml and treespec.yaml
 */

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Spec } from './types.js';
import type { TreespecConfig } from './config.js';

// ─── Assertion ───────────────────────────────────────────────────

const RegexConditionSchema = z.object({
	path: z.string().min(1),
	regex: z.string().min(1),
});

const RegexAssertionSchema = z.object({
	type: z.literal('regex'),
	conditions: z.array(RegexConditionSchema).min(1),
});

const JsonataAssertionSchema = z.object({
	type: z.literal('jsonata'),
	expression: z.string().min(1),
});

const LlmAssertionSchema = z.object({
	type: z.literal('llm'),
	prompt: z.string().min(1),
});

const AssertionSchema = z.discriminatedUnion('type', [
	RegexAssertionSchema,
	JsonataAssertionSchema,
	LlmAssertionSchema,
]);

// ─── HTTP / Wait ─────────────────────────────────────────────────

const HttpRequestSchema = z.object({
	method: z.string().min(1),
	url: z.string().min(1),
	headers: z.record(z.string()).optional(),
	body: z.unknown().optional(),
});

const WaitConfigSchema = z.object({
	timeout: z.string().min(1),
	delay: z.string().min(1).optional(),
});

// ─── Steps (discriminated union; default type = 'exec') ──────────

const ExecStepSchema = z.object({
	type: z.literal('exec'),
	command: z.string().min(1),
	timeout: z.string().min(1).optional(),
	assert: AssertionSchema.optional(),
	wait: WaitConfigSchema.optional(),
});

const HttpStepSchema = z.object({
	type: z.literal('http'),
	request: HttpRequestSchema,
	timeout: z.string().min(1).optional(),
	assert: AssertionSchema.optional(),
	wait: WaitConfigSchema.optional(),
});

const StepSchema = z.preprocess((val) => {
	if (val !== null && typeof val === 'object' && !Array.isArray(val) && !('type' in val)) {
		return { ...val, type: 'exec' };
	}
	return val;
}, z.discriminatedUnion('type', [ExecStepSchema, HttpStepSchema]));

// ─── PostCondition / Spec ────────────────────────────────────────

const PostConditionSchema = z.object({
	name: z.string().min(1),
	steps: z.array(StepSchema).min(1),
});

export const SpecSchema = z.object({
	description: z.string().optional(),
	env: z.array(z.string().min(1)).optional(),
	steps: z.array(StepSchema).min(1),
	postcon: z.array(PostConditionSchema).optional(),
});

// ─── Config ──────────────────────────────────────────────────────

const ImageConfigSchema = z.object({
	dockerfile: z.string().min(1).optional(),
	tag: z.string().min(1).optional(),
	args: z.record(z.string()).optional(),
});

const DockerConfigSchema = z.object({
	network: z.string().min(1).optional(),
	extra_hosts: z.array(z.string().min(1)).optional(),
});

export const TreespecConfigSchema = z.object({
	name: z.string().min(1).optional(),
	image: ImageConfigSchema.optional(),
	docker: DockerConfigSchema.optional(),
	projectDir: z.string().min(1).refine(
		(p) => !p.startsWith('/'),
		'projectDir must be a relative path (absolute paths starting with / are not allowed)',
	).optional(),
	spec: z.string().min(1),
	output: z.string().min(1).optional(),
});

// ─── Parse helpers ───────────────────────────────────────────────

function formatZodError(error: z.ZodError): string {
	return error.issues
		.map((issue) => {
			const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
			return `${path}: ${issue.message}`;
		})
		.join('; ');
}

export function parseSpec(yamlString: string): Spec {
	let raw: unknown;
	try {
		raw = parseYaml(yamlString);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid YAML: ${message}`);
	}

	const result = SpecSchema.safeParse(raw);
	if (!result.success) {
		throw new Error(formatZodError(result.error));
	}
	return result.data as Spec;
}

export function parseConfig(yamlString: string): TreespecConfig {
	let raw: unknown;
	try {
		raw = parseYaml(yamlString);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Invalid YAML: ${message}`);
	}

	const result = TreespecConfigSchema.safeParse(raw);
	if (!result.success) {
		throw new Error(formatZodError(result.error));
	}
	return result.data as TreespecConfig;
}
