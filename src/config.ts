/**
 * treespec — Type definitions for treespec.yaml (project configuration)
 */

// ─── Image Config ───────────────────────────────────────────────

export interface ImageConfig {
	/**
	 * Dockerfile path, relative to treespec.yaml.
	 * Used to build the base image (S₀) for the test tree.
	 * Optional: can be omitted if --image flag is used instead.
	 */
	dockerfile?: string;
	/**
	 * Base image tag. treespec checks if this tag already exists:
	 *   - exists + no --rebuild → skip build, use existing tag
	 *   - exists + --rebuild    → rebuild
	 *   - not exists             → build
	 * If omitted, defaults to `<name>-test:base` (requires `name` in config).
	 */
	tag?: string;
	/** Optional Docker build args. */
	args?: Record<string, string>;
}

// Image resolution priority:
//   1. CLI --image <tag>  → use directly, no build
//   2. image.dockerfile    → build from Dockerfile
//   3. Neither              → error

// ─── LLM Config (resolved from env vars, not in treespec.yaml) ──

export interface LlmConfig {
	/** OpenAI-compatible API endpoint. */
	base_url: string;
	/** Model name. */
	model: string;
	/** API key (resolved value, not env var name). */
	api_key: string;
}

// ─── Project Config ─────────────────────────────────────────────

export interface TreespecConfig {
	/**
	 * Test suite name. Used for:
	 *   - Trace filename prefix: `<name>-<timestamp>.jsonl`
	 *   - Image tag default: `<name>-test:base` (when image.tag omitted)
	 * If omitted, falls back to the directory name containing treespec.yaml.
	 */
	name?: string;
	/** Base image build configuration. Optional (--image flag can be used instead). */
	image: ImageConfig;
	/**
	 * Path to the project root, relative to treespec.yaml's directory.
	 * Defaults to "." (treespec.yaml's own directory).
	 * Mounted read-only at /app inside every container.
	 * Must be a relative path — absolute paths are rejected.
	 */
	projectDir?: string;
	/**
	 * Root directory of the test tree, relative to projectDir.
	 * treespec recursively scans for directories containing spec.yaml.
	 * The directory hierarchy = test tree structure.
	 */
	spec: string;
	/** Required only if any test case uses `assert: { type: 'llm' }`.
	 * LLM config is read from env vars: TREESPEC_LLM_BASE_URL,
	 * TREESPEC_LLM_MODEL, TREESPEC_LLM_API_KEY. */
	output?: string;
}

// ─── Conventions (not configurable) ─────────────────────────────

// .env is always read from treespec.yaml's directory.
// Use `treespec run --env-file <path>` to override at runtime.
//
// Env var resolution order:
//   1. Shell environment variables
//   2. .env file (treespec.yaml's sibling, or --env-file override)
//   3. TestCase `env` field declares required vars (missing → SKIP)
