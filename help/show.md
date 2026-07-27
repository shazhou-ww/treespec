treespec show — replay a trace as human-readable output

Usage: treespec show <trace.jsonl> [options]

Reads a JSONL trace file and prints the same human-readable tree output
that was shown during "treespec run". Useful for reviewing past runs.

═══════════════════════════════════════════════════════════════

Options:

  --verbose, -v       Show full stdout/stderr for every step
  --failures, -f      Show only failed nodes and steps
  --help, -h          Show this help

═══════════════════════════════════════════════════════════════

Trace structure (JSONL — one JSON object per line):

  meta     Run metadata (name, started_at, total_nodes, base_image)
  step     Step records (index, node_path, command, stdout, stderr,
           exit_code, verdict, reason, duration_ms)
  summary  Final result (total, passed, failed, skipped, duration_ms,
           ended_at)

Step record fields:

  index          Step number (0-based, within node)
  node_path      Tree path of the node (depth = count of "/")
  command        Shell command executed
  stdout         Full command stdout (not truncated)
  stderr         Full command stderr
  exit_code      Process exit code
  verdict        PASS | FAIL
  reason         One-line explanation from the judge
  duration_ms    Execution time in milliseconds

═══════════════════════════════════════════════════════════════

Examples:

  # Replay a trace
  treespec show .treespec-output/trace.jsonl

  # Only show failures (with full output)
  treespec show .treespec-output/trace.jsonl -fv

  # jq for quick pass/fail check
  jq -r 'select(.type=="summary") | "\(.passed) passed, \(.failed) failed"' trace.jsonl

  # jq for all failed steps
  jq -r 'select(.type=="step" and .verdict=="FAIL") | "\(.node_path) step \(.index+1): \(.reason)"' trace.jsonl

  # jq for per-node step counts
  jq -r 'select(.type=="step") | .node_path' trace.jsonl | sort | uniq -c | sort -rn

═══════════════════════════════════════════════════════════════

Exit codes:

  0   All steps passed (no failures, no skips)
  1   Trace has failures or skipped nodes, or file unreadable

See also:
  treespec run --help   — how traces are generated
  treespec tree --help  — tree structure visualization
