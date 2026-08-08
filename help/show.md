treespec show — replay a trace as human-readable output

Usage: treespec show <trace.jsonl> [node-path] [options]

Options:
  --verbose, -v       Show full stdout/stderr for every step
  --failures, -f      Show only failed nodes and steps
  -h, --help          Show this help

Examples:
  treespec show .treespec-output/trace.jsonl
  treespec show .treespec-output/trace.jsonl bootstrap/add-specs
  treespec show .treespec-output/trace.jsonl -fv

For diagnosing failures, run: treespec docs diagnosing-failures
