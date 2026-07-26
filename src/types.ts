/**
 * treespec — Type definitions for test case YAML (user-facing spec format)
 */

// ─── Assertion Types ────────────────────────────────────────────

export interface RegexCondition {
	/**
	 * Path to the value to match against.
	 * exec:  'stdout' | 'stderr' | 'exit_code'
	 * http:  'status' | 'body' | 'headers.<name>'
	 */
	path: string;
	/** Regex pattern. Match = PASS. */
	regex: string;
}

export interface RegexAssertion {
	type: 'regex';
	/** All conditions must match (AND logic). */
	conditions: RegexCondition[];
}

export interface JsonataAssertion {
	type: 'jsonata';
	/**
	 * JSONata expression evaluated against the step's result object.
	 * exec input:  { stdout, stderr, exit_code }
	 * http input:  { status, statusText, headers, body, duration_ms }
	 * Truthy = PASS.
	 */
	expression: string;
}

export interface LlmAssertion {
	type: 'llm';
	/** Natural language criteria for the LLM to judge against. */
	prompt: string;
}

export type Assertion = RegexAssertion | JsonataAssertion | LlmAssertion;

// ─── HTTP Request ────────────────────────────────────────────────

export interface HttpRequest {
	/** HTTP method (GET, POST, PUT, PATCH, DELETE, etc.) */
	method: string;
	/** Request URL. Supports $ENV_VAR substitution. */
	url: string;
	/** Request headers. Values support $ENV_VAR substitution. */
	headers?: Record<string, string>;
	/** Arbitrary JSON body, serialized automatically. Supports $ENV_VAR in string values. */
	body?: unknown;
}

// ─── Step Types (discriminated union) ────────────────────────────

export interface ExecStep {
	type: 'exec';
	/** Shell command to execute inside the container. Supports $ENV_VAR substitution. */
	command: string;
	/** Duration string: "30s", "2m", "1h". Default: "30s". */
	timeout?: string;
	/** Assertion on step output. Omit = transition step (exit code 0 = PASS). */
	assert?: Assertion;
}

export interface HttpStep {
	type: 'http';
	request: HttpRequest;
	/** Duration string: "30s", "2m". Default: "30s". */
	timeout?: string;
	/** Assertion on response. Omit = transition step (HTTP 2xx = PASS). */
	assert?: Assertion;
}

export type Step = ExecStep | HttpStep;

// ─── PostCondition ──────────────────────────────────────────────

export interface PostCondition {
	/** Identifier for this post-condition block. */
	name: string;
	/** Steps to execute in an isolated container started from the committed tag. */
	steps: Step[];
}

// ─── TestCase ────────────────────────────────────────────────────

export interface TestCase {
	/**
	 * Parent node file path, relative to this file.
	 * - Same dir:   './provider-add.yaml'
	 * - Parent dir: '../provider/model-add.yaml'
	 * Omit for root nodes (tree root = base image).
	 */
	parent?: string;
	/** Unique identifier for this test case. */
	name: string;
	/** Human-readable description. Shown to LLM judge as context. */
	description?: string;
	/**
	 * Required environment variables.
	 * If any is missing → this node is SKIPPED and its entire subtree is pruned
	 * (children marked SKIPPED with reason "parent skipped").
	 */
	env?: string[];
	/** Main steps — executed in the pre-condition container (before commit). */
	steps: Step[];
	/**
	 * Post-conditions — executed in an isolated container started from the
	 * committed (post-condition) tag. Container is destroyed after use.
	 */
	postcon?: PostCondition[];
}
