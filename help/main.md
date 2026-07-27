treespec {{version}} — tree-structured, stateful test system

Directory tree = test tree. Each folder with spec.yaml = a test case.
State passes parent→child via `docker commit`. DFS traversal, failure pruning.

Minimal spec.yaml:
  description: "echo hello"
  steps:
    - type: exec
      command: "echo hello"
      assert:
        type: regex
        conditions:
          - { path: "stdout", regex: "hello" }

Project config (treespec.yaml):
  name: myapp                     # test suite name (trace prefix, image tag default)
  image:
    dockerfile: tests/Dockerfile  # omit tag → defaults to <name>-test:base
    tag: myapp-test:base
  specs: tests

Commands:
  treespec run [paths...] [options]   DFS-execute the test tree (or subtrees)
  treespec show <trace.jsonl>         Replay a trace as human-readable output
  treespec validate [--config <path>] Check config + spec tree for errors
  treespec tree [--config <path>]     Visualize the test tree structure
  treespec init <path>                Create a project scaffold
  treespec clean                      Remove all ephemeral image tags
  treespec help                       Show this help

Common flags:
  --image <tag>        Use existing image (skip build)
  --config <path>      Override treespec.yaml path
  --output <path>      Output path (dir → timestamped, .jsonl → exact file)
  --no-trace           Skip trace JSONL output
  --verbose, -v        Show full step output
  --no-mount           Specs in image (skip bind mount, for DinD)
  --keep-tags          Keep ephemeral tags after run (debug)
  --rebuild            Force rebuild base image

Test tree design principles:
  Organize by lifecycle, not by feature.
    init → validate → add cases → run → observe (trace, tree)
    NOT: group by "http tests", "exec tests", "trace tests"

  Step types are orthogonal to the workflow.
    exec and http are parallel variants under passing/failing —
    they are step types, not test categories.

  Observation follows action.
    show-tree after cases exist; show-trace after a run happened.
    A node that observes state should be a child of the node that creates it.

  State dependency drives hierarchy.
    If B needs A's state, B is a child of A.
    Siblings are independent — each starts from parent's committed state.
    This minimizes repeated precondition setup.

  Isolate broken/error cases.
    Put invalid specs in a separate subtree so they don't pollute
    the main validation flow.

Example (self-test bootstrap tree):
  bootstrap/
    spec.yaml              init project
    validate-fresh/        validate initial state
    add-specs/             add exec+http, passing+failing
      validate-passes/     validate after adding
      run-all/             run → 3 passed, 2 failed
      run-with-trace/      run with trace → show trace
      show-tree/           tree shows all specs
    add-bad-spec/          broken spec (isolated)
      validate-rejects/    validate → error

For details:
  treespec run --help       — spec format, assert types, wait, postcon, examples
  treespec show --help      — trace format, field reference, jq queries
  treespec validate --help  — validation rules, common errors
  treespec tree --help      — tree output format
  treespec init --help      — scaffold structure
  treespec clean --help     — tag naming, cleanup scope