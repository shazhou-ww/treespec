treespec lineage — show the primary descent line (大宗)

Show the main line of succession: from a given node, follow the `primary`
field chain upward to root (先祖) and downward to leaf (大宗).

Output is a linear list — not a tree — because this is a path, not a hierarchy.
Contrast with `tree` which shows the full tree including all branches (小宗).

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

═══════════════════════════════════════════════════════════════

Scope modes:

  Default (no flag):
    root → ... → [start] → ... → leaf
    Full main line through the node: ancestors + descendants.

  --only-descends:
    [start] → ... → leaf
    Just the primary path downward. Useful to see "what happens next
    on the main line from here."

  --only-ancestors:
    root → ... → [start]
    Just the ancestor chain. The starting node is marked with ← here.
    (Starting node's own steps/asserts still shown per detail flags.)

  --only-descends and --only-ancestors are mutually exclusive.

═══════════════════════════════════════════════════════════════

Detail levels (composable):

  Default:    node name + description (one line per node)
  --steps:    + steps (type, command, timeout, wait)
  --asserts:  + assert (type, conditions for regex; expression for jsonata; prompt for llm)
  --postcon:  + postcon (name + step count)
  -v:         all of the above

═══════════════════════════════════════════════════════════════

Examples:

  Default (from root, names only):

    $ treespec lineage

    root — treespec self-test tree root
    bootstrap — init a treespec project and prepare Dockerfile for DinD
    add-specs — add passing and failing specs (exec + http step types)
    run-all — run all specs — expect 3 passed and 2 failed

  Ancestors only (from a node):

    $ treespec lineage bootstrap/add-specs --only-ancestors

    root — treespec self-test tree root
    bootstrap — init a treespec project and prepare Dockerfile for DinD
    add-specs — add passing and failing specs ← here

  Descends only, verbose:

    $ treespec lineage bootstrap/add-specs --only-descends -v

    add-specs — add passing and failing specs (exec + http step types)
      steps:
        1. exec: mkdir -p /tmp/bootstrap-project/spec/passing ...
        2. exec: mkdir -p /tmp/bootstrap-project/spec/failing ...
        3. exec: mkdir -p /tmp/bootstrap-project/spec/http ...
      assert: regex /specs added/
      primary → run-all
    run-all — run all specs — expect 3 passed and 2 failed
      steps:
        1. exec: treespec run --config /tmp/bootstrap-project/treespec.yaml ...
      assert: regex /3 passed/
      (leaf)

═══════════════════════════════════════════════════════════════

Pitfalls:

1. Lineage follows `primary` field only. Nodes that are branches (小宗)
   are not on the main line — use `tree` to see all branches.

2. If the starting node is a branch (not reachable via primary chain from
   root), --only-ancestors shows nothing. The node's own primary descendants
   still work with --only-descends.

3. If the starting node has no primary child, the descendant line ends
   immediately (leaf node). Use --only-ancestors to see its context.

4. Organizational nodes (no spec.yaml) appear in the lineage if they are
   on the primary path — they pass through without execution.

5. --only-descends and --only-ancestors cannot be combined. If both are
   passed, --only-ancestors takes precedence (shows the shorter path).
