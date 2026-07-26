/**
 * treespec — Type definitions for treespec.yaml (project configuration)
 */

// ─── Image Config ───────────────────────────────────────────────

export interface ImageConfig {
	/**
	 * Dockerfile path, relative to treespec.yaml.
	 * The Dockerfile builds the base image (S₀) for the test tree.
	 */
	dockerfile: string;
	/**
	 * Base image tag. treespec checks if this tag already exists:
	 *   - exists + no --rebuild → skip build, use existing tag
	 *   - exists + --rebuild    → rebuild
	 *   - not exists             → build
	 * Each project should specify its own unique tag to avoid collisions.
	 */
	tag: string;
	/** Optional Docker build args. */
	args?: Record<string, string>;
}

// ─── LLM Config ─────────────────────────────────────────────────

export interface LlmConfig {
	/**
	 * OpenAI-compatible API endpoint.
	 * Example: 'https://api.openai.com/v1'
	 */
	base_url: string;
	/** Model name. Example: 'gpt-4o'. */
	model: string;
	/**
	 * Name of the environment variable that holds the API key.
	 * The key itself is never written to YAML — only the env var name.
	 * Example: 'OPENAI_API_KEY' → treespec reads $OPENAI_API_KEY at runtime.
	 */
	api_key_env: string;
}

// ─── Project Config ─────────────────────────────────────────────

export interface TreespecConfig {
	/** Base image build configuration. Required. */
	image: ImageConfig;
	/**
	 * LLM configuration for 'llm' assertion type.
	 * Required only if any test case uses `assert: { type: 'llm' }`.
	 */
	llm?: LlmConfig;
	/**
	 * Output directory for test results and logs.
	 * Default: '.treespec-output'
	 */
	output?: string;
}

// ─── Conventions (not configurable) ─────────────────────────────

// Test tree root: `tests/` directory next to treespec.yaml.
// treespec recursively scans for directories containing spec.yaml.
// Use `treespec run --tests-dir <path>` to override at runtime.
//
// .env is always read from treespec.yaml's directory.
// Use `treespec run --env-file <path>` to override at runtime.
//
// Env var resolution order:
//   1. Shell environment variables
//   2. .env file (treespec.yaml's sibling, or --env-file override)
//   3. TestCase `env` field declares required vars (missing → SKIP)
