# Diagnosing Failures

How to investigate test failures: reading traces, jq queries, lineage,
and common failure patterns.

## 1. Reading Traces with `show`

```
treespec show <trace.jsonl> [node-path] [options]
```

Reads a JSONL trace file and prints the same human-readable tree output that
was shown during `treespec run`. Useful for reviewing past runs.

When `[node-path]` is given, shows only the lineage (primary chain) through
that node — ancestors, the node itself, and its primary descendants.
Branch nodes (小宗) show the node + its own primary descendants.

### Options

```
--verbose, -v       Show full stdout/stderr for every step
--failures, -f      Show only failed nodes and steps
-h, --help          Show this help
```

### Examples

```bash
# Replay a trace
treespec show .treespec-output/trace.jsonl

# Show lineage through a specific node (primary chain)
treespec show .treespec-output/trace.jsonl bootstrap/add-specs

# Only show failures (with full output)
treespec show .treespec-output/trace.jsonl -fv

# Lineage + failures only
treespec show .treespec-output/trace.jsonl bootstrap/add-specs -f
```

### Exit codes

- `0` — trace displayed successfully (regardless of pass/fail content)
- `1` — file unreadable or no valid trace records found

## 2. Trace JSONL Format

One JSON object per line. Three line types:

### meta — Run metadata

```
type, started_at, total_nodes, base_image, roots, primary_map
```

### step — Step records

| Field | Description |
|-------|-------------|
| `index` | Step number (0-based, within node) |
| `node_path` | Tree path of the node (depth = count of `/`) |
| `command` | Shell command executed |
| `stdout` | Full command stdout (not truncated) |
| `stderr` | Full command stderr |
| `exit_code` | Process exit code |
| `verdict` | `PASS` or `FAIL` |
| `reason` | One-line explanation from the judge |
| `duration_ms` | Execution time in milliseconds |

### summary — Final result

```
type, total, passed, failed, skipped, duration_ms, ended_at
```

## 3. jq Queries

Quick pass/fail check:
```bash
jq -r 'select(.type=="summary") | "\(.passed) passed, \(.failed) failed"' trace.jsonl
```

All failed steps:
```bash
jq -r 'select(.type=="step" and .verdict=="FAIL") | "\(.node_path) step \(.index+1): \(.reason)"' trace.jsonl
```

Per-node step counts:
```bash
jq -r 'select(.type=="step") | .node_path' trace.jsonl | sort | uniq -c | sort -rn
```

## 4. Lineage (Primary Descent Line — 大宗)

```
treespec lineage [node] [options]
```

Show the main line of succession: from a given node, follow the `primary`
field chain upward to root (先祖) and downward to leaf (大宗).

Output is a linear list — not a tree — because this is a path, not a hierarchy.
Contrast with `tree` which shows the full tree including all branches (小宗).

### Options

```
--only-descends        Show only descendants (start → leaf, no ancestors)
--only-ancestors       Show only ancestors (root → start, no descendants)
--steps                Show step details (type, command)
--asserts              Show assertion details (type, conditions/prompt)
--postcon              Show post-condition details (name, step count)
-v, --verbose          Show all details (steps + asserts + postcon)
--config <path>        Override treespec.yaml path
-h, --help             Show this help
```

### Scope modes

Default (no flag):
```
root → ... → [start] → ... → leaf
Full main line through the node: ancestors + descendants.
```

`--only-descends`:
```
[start] → ... → leaf
Just the primary path downward. Useful to see "what happens next
on the main line from here."
```

`--only-ancestors`:
```
root → ... → [start]
Just the ancestor chain. The starting node is marked with ← here.
```

`--only-descends` and `--only-ancestors` are mutually exclusive.

### Detail levels (composable)

```
Default:    node name + description (one line per node)
--steps:    + steps (type, command, timeout, wait)
--asserts:  + assert (type, conditions for regex; expression for jsonata; prompt for llm)
--postcon:  + postcon (name + step count)
-v:         all of the above
```

### Examples

Default (from root, names only):
```
$ treespec lineage

root — treespec self-test tree root
bootstrap — init a treespec project and install SUT (greet CLI)
add-specs — copy all spec trees into project at once
validate — validate project with all specs
```

Ancestors only (from a node):
```
$ treespec lineage bootstrap/add-specs --only-ancestors

root — treespec self-test tree root
bootstrap — init a treespec project and install SUT (greet CLI)
add-specs — copy all spec trees into project at once ← here
```

Descends only, verbose:
```
$ treespec lineage bootstrap/add-specs --only-descends -v

add-specs — copy all spec trees into project at once
  steps:
    1. exec: cp -r /app/spec/assets/spec/greet /workspace/greeting/spec/ && ...
  primary → validate
validate — validate project with all specs
  steps:
    1. exec: treespec validate --config /workspace/greeting/treespec.yaml ...
  assert: regex /Valid/
  (leaf)
```

## 5. Common Failure Patterns

### Parent failed → children skipped

Any assertion failure (step or postcon) → node FAIL → entire subtree pruned.
Children show as SKIP. This prevents testing on untrusted state.

```
fails-on-purpose/          # exit 1 → FAIL
  should-be-skipped/       # SKIP (parent failed)
```

If you see unexpected SKIPs in children, check the parent node's failure reason.

### Missing env vars → SKIP (not FAIL)

If a node declares `env: [API_KEY]` and `API_KEY` is not set, the node and
all its children are SKIP'd — not FAIL'd. Check `.env` file and shell env.

### Branch nodes not on primary chain

Lineage follows `primary` field only. Nodes that are branches (小宗) are not
on the main line — use `tree` to see all branches.

If the starting node is a branch (not reachable via primary chain from root),
`--only-ancestors` shows nothing. Use `--only-descends` to see its primary
descendants, or `tree` to see the full tree.

### Lineage pitfalls

1. If the starting node has no primary child, the descendant line ends
   immediately (leaf node). Use `--only-ancestors` to see its context.

2. Assets nodes (directories without `spec.yaml`) are not part of the test
   tree and never appear in lineage. Only test nodes with `spec.yaml` do.

3. `--only-descends` and `--only-ancestors` cannot be combined. If both are
   passed, `--only-ancestors` takes precedence (shows the shorter path).
