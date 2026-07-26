treespec tree — visualize the test tree structure

Usage: treespec tree [--config <path>]

Options:
  --config <path>   Override treespec.yaml path
  -h, --help         Show this help

Output format:
  S₀ (base image)
  ├── node-name — description [env: VAR] [postcon: name]
  │   └── child-name — description
  └── org-node [org]

Markers:
  [org]       — organizational node (no spec.yaml, pass-through)
  [env: VAR]  — declares required env vars
  [postcon: name] — has post-condition verification