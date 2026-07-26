treespec validate — check config + spec tree for errors

Usage: treespec validate [--config <path>]

Options:
  --config <path>   Override treespec.yaml path (default: ./treespec.yaml)
  -h, --help         Show this help

Checks:
  - treespec.yaml parses correctly (image, specs, llm fields)
  - specs directory exists and is a directory
  - All spec.yaml files parse correctly (YAML + schema validation)
  - No empty nodes (directory without spec.yaml AND without subdirs)
  - Env var declarations are valid

Output: config summary + tree visualization + node count + env vars + errors.

Exit code: 0 = valid, 1 = errors found.