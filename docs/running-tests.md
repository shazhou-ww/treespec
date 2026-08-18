# Running Tests

How to run treespec tests: project setup, config, paths and globs,
trace output, and LLM assertion configuration.

## 1. Quick Start

```bash
# Create a project scaffold
treespec init myproject --name myapp
cd myproject

# Customize spec/Dockerfile, then add your test specs under spec/
# Run the test tree
treespec run

# Check results
treespec show .treespec-output/*.jsonl
```

## 2. Project Config (treespec.yaml)

```yaml
name: myapp                     # test suite name (trace prefix, image tag default)
image:
  dockerfile: spec/Dockerfile  # omit tag → defaults to <name>-test:base
  tag: myapp-test:base          # optional, auto-resolved from name
projectDir: .                   # default: treespec.yaml's dir, mounted at /app:ro
spec: spec                      # relative to projectDir, scanned for spec.yaml
# output: .treespec-output     # default trace output directory
# docker:                      # optional, Docker runtime config
#   network: host              #   network mode (host/bridge/none/custom)
#   extra_hosts:               #   extra host entries (same as docker --add-host)
#     - host.docker.internal:host-gateway
```

### Fields

| Field | Default | Description |
|-------|---------|-------------|
| `name` | directory basename | Suite name — used in trace prefix and image tag default |
| `image.dockerfile` | — | Path to Dockerfile (relative to config dir) |
| `image.tag` | `<name>-test:base` | Base image tag |
| `projectDir` | `.` | Project root, mounted read-only at `/app` inside containers |
| `spec` | `spec` | Specs root, relative to projectDir |
| `output` | `.treespec-output` | Trace output directory |
| `docker.network` | — | Docker network mode |
| `docker.extra_hosts` | — | Extra host entries (like `docker --add-host`) |

## 3. Docker Runtime

### Image build

- If `image.dockerfile` is set, treespec builds the base image on first run
  and caches it by tag.
- Use `--rebuild` to force rebuild (requires `image.dockerfile`).
- Use `--image <tag>` to skip building and use an existing image.
- Don't combine `--rebuild` with `--image`.

### Network

- Default: bridge (Docker default).
- Set `docker.network: host` if specs need host networking.
- All steps run inside the container — `curl` can access
  container-local services (`localhost:PORT`) regardless of network mode.

## 4. Running the Tree

```
treespec run [paths...] [options]
```

### Paths

Optional positional args — node paths or globs. If omitted, runs the entire tree.

```bash
treespec run                    # run entire tree
treespec run provider-add      # run subtree (auto-pulls ancestors)
treespec run "provider-*"      # glob match
```

When you specify a node, treespec automatically pulls in all ancestor nodes
to ensure the required state exists. Only the covering subtree is executed.

### Options

```
--config <path>       Override treespec.yaml path
--image <tag>         Use existing image as base (skip build)
--rebuild             Force rebuild (requires image.dockerfile in config)
--env-file <path>     Override .env path
--output <path>       Override output path (dir or .jsonl file)
                       Dir: trace-<timestamp>.jsonl inside
                       File: used directly (no timestamp)
--no-trace            Skip writing trace JSONL
--keep-tags           Keep ephemeral image tags after run (debug)
--verbose, -v         Show full step output in terminal
-h, --help            Show this help
```

### Common flags (also work with other commands)

```
--image <tag>        Use existing image (skip build)
--config <path>      Override treespec.yaml path
--output <path>      Output path (dir → timestamped, .jsonl → exact file)
--no-trace           Skip trace JSONL output
--verbose, -v        Show full step output
--keep-tags          Keep ephemeral tags after run (debug)
--rebuild            Force rebuild base image
```

## 5. Trace Output (JSONL)

Default: `.treespec-output/<name>-<timestamp>.jsonl` (non-overwriting)
`--output <dir>` → `<dir>/<name>-<timestamp>.jsonl`
`--output file.jsonl` → `file.jsonl` (exact, no timestamp)

`<name>` comes from `treespec.yaml` `name` field, or directory basename if unset.

### Line types

```
meta     { type, started_at, total_nodes, base_image, roots, primary_map }
step     { type, node_path, step_index, command, stdout, stderr, exit_code, verdict, reason, duration_ms }
summary  { type, total, passed, failed, skipped, duration_ms, ended_at }
```

Use `--no-trace` to skip. Use `--output <path>` to override location.

## 6. LLM Assertions Setup

LLM assertions (`type: llm`) require three env vars:

```
TREESPEC_LLM_BASE_URL   # e.g. https://api.openai.com/v1
TREESPEC_LLM_MODEL      # e.g. gpt-4o
TREESPEC_LLM_API_KEY    # your API key
```

Put them in `.env` (sibling of `treespec.yaml`) or export in shell.
If any is missing → specs with `llm` asserts auto-skip (not error).

treespec merges env vars from `.env` file + process environment.
Shell env takes precedence over `.env` file.

## 7. Other Commands

```
treespec validate [--config <path>]   Check config + spec tree for errors
treespec tree [--config <path>]       Visualize the full test tree structure
treespec lineage [node] [options]     Show the primary descent line (大宗)
treespec init <path>                  Create a project scaffold
treespec clean                        Remove all ephemeral image tags
treespec show <trace.jsonl>           Replay a trace as human-readable output
```

## Pitfalls

1. `--image` overrides `image.dockerfile` in config. `--rebuild` requires
   dockerfile. Don't use `--rebuild` with `--image`.

2. If a run is interrupted (Ctrl+C), ephemeral image tags may be left behind.
   Use `treespec clean` to remove them.
