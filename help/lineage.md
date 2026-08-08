treespec lineage — show the primary descent line

Usage: treespec lineage [node] [options]

Node: optional path (relative to specs root) or spec.yaml file path.
If omitted, starts from root — shows the full main line.

Options:
  --only-descends        Show only descendants (start → leaf, no ancestors)
  --only-ancestors       Show only ancestors (root → start, no descendants)
  --steps                Show step details (type, command)
  --asserts              Show assertion details (type, conditions/prompt)
  --postcon              Show post-condition details (name, step count)
  -v, --verbose          Show all details (steps + asserts + postcon)
  --config <path>        Override treespec.yaml path
  -h, --help             Show this help

For lineage details and diagnosing failures, run: treespec docs diagnosing-failures
