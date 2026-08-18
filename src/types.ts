/**
 * treespec — Type definitions for test case YAML (user-facing spec format)
 *
 * Each test case = a directory containing `spec.yaml`.
 * The directory hierarchy IS the test tree — no parent field needed.
 */

// ─── Assertion Types ────────────────────────────────────────────

export interface RegexCondition {
	/**
	 * Path to the value to match against.
	 * exec:  'stdout' | 'stderr' | 'exit_code'
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
	 * exec input: { stdout, stderr, exit_code }
	 * Truthy = PASS.
	 */
	expression: string;
}

export interface ExitCodeAssertion {
	type: 'exit_code';
	/** Expected exit code. Default: 0. */
	equals?: number;
}

export interface LlmAssertion {
	type: 'llm';
	/** Natural language criteria for the LLM to judge against. */
	prompt: string;
}

export type Assertion = RegexAssertion | JsonataAssertion | ExitCodeAssertion | LlmAssertion;

// ─── Wait Config ────────────────────────────────────────────────

export interface WaitConfig {
	/**
	 * Max total wait time. E.g., "2m".
	 * Elapsed time is measured from the first attempt's start.
	 * Exceeding this → FAIL with reason "wait timeout exceeded".
	 */
	timeout: string;
	/**
	 * Delay between one attempt finishing and the next starting.
	 * NOT a fixed polling period — the gap is inserted after each attempt completes.
	 * Default: "5s".
	 */
	delay?: string;
}

// ─── Step Type ──────────────────────────────────────────────────

export interface ExecStep {
	type: 'exec';
	/** Shell command to execute inside the container. Supports $ENV_VAR substitution. */
	command: string;
	/** Working directory inside the container. Default: container's WorkingDir. */
	cwd?: string;
	/** Human-readable description shown in output. Falls back to command if omitted. */
	description?: string;
	/** Duration string: "30s", "2m", "1h". Default: "30s". */
	timeout?: string;
	/** Assertion on step output. Omit = transition step (exit code 0 = PASS). */
	assert?: Assertion;
	/**
	 * Wait for a precondition to become true.
	 * On assert FAIL: wait `delay`, re-execute the step, re-evaluate.
	 * Repeats until PASS or `wait.timeout` exceeded.
	 * Replaces atest's retry — models "wait for readiness", not "retry on failure".
	 */
	wait?: WaitConfig;
}

export type Step = ExecStep;

// ─── PostCondition ──────────────────────────────────────────────

export interface PostCondition {
	/** Identifier for this post-condition block. */
	name: string;
	/** Steps to execute in an isolated container started from the committed tag. */
	steps: Step[];
}

// ─── Spec (test case definition in spec.yaml) ────────────────────

export interface Spec {
	/**
	 * Human-readable description. Shown to LLM judge as context.
	 * For longer documentation, use a companion .md file in the same directory.
	 */
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
	/**
	 * Primary child (嫡长子) — the main-line continuation of this node.
	 * Directory name relative to this node's directory.
	 * Required when this node has children; the primary child chain
	 * (recursing through `primary`) forms the main business flow.
	 */
	primary?: string;
	/**
	 * Branch children — additional sub-trees that fork off the main line.
	 * Directory names relative to this node's directory.
	 * A node may have branches without primary only if it has no children
	 * at all (leaf node). When children exist, `primary` is mandatory.
	 */
	branches?: string[];
}
