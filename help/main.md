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
    dockerfile: spec/Dockerfile  # omit tag → defaults to <name>-test:base
    tag: myapp-test:base
  projectDir: .                   # default: treespec.yaml's dir, mounted at /app:ro
  spec: spec                     # relative to projectDir, scanned for spec.yaml
  # docker:                      # optional, Docker runtime config
  #   network: host              #   network mode (host/bridge/none/custom)
  #   extra_hosts:               #   extra host entries (same as docker --add-host)
  #     - host.docker.internal:host-gateway

Commands:
  treespec run [paths...] [options]   DFS-execute the test tree (or subtrees)
  treespec show <trace.jsonl>         Replay a trace as human-readable output
  treespec validate [--config <path>] Check config + spec tree for errors
  treespec tree [--config <path>]     Visualize the full test tree structure
  treespec lineage [node] [options]  Show the primary descent line (大宗)
  treespec init <path>                Create a project scaffold
  treespec clean                      Remove all ephemeral image tags
  treespec help                       Show this help

Common flags:
  --image <tag>        Use existing image (skip build)
  --config <path>      Override treespec.yaml path
  --output <path>      Output path (dir → timestamped, .jsonl → exact file)
  --no-trace           Skip trace JSONL output
  --verbose, -v        Show full step output
  --keep-tags          Keep ephemeral tags after run (debug)
  --rebuild            Force rebuild base image

LLM assertions (type: llm):
  Set TREESPEC_LLM_BASE_URL, TREESPEC_LLM_MODEL, TREESPEC_LLM_API_KEY
  env vars. Missing → specs with llm asserts auto-skip.
  Put them in .env (treespec.yaml's sibling) or export in shell.

Test tree design:

  Core model: nodes are STATES, edges are TRANSITIONS.

  Each directory with spec.yaml = an edge (a transition from parent's
  committed state to a new state). The directory name should be a VERB
  PHRASE describing the action that causes the transition:

    add-provider/        ← "add a provider" → state now has a provider
    run-all/             ← "run all specs" → state now has test results
    show-tree/           ← "show the tree" → observe current state
    validate-fresh/     ← "validate fresh project" → assert initial state

  NOT nouns or categories:
    providers/           ← what about them? not an action
    http-tests/          ← a category, not a transition
    config/              ← a thing, not something you do

  The verb phrase answers: "what does this transition DO to the system?"
    parent state --[add-provider]--> child state (provider added)
    parent state --[run-all]--------> child state (results produced)

  Principles:

  1. Organize by lifecycle, not by feature.
     init → validate → add → run → observe
     Step types (exec, http), pass/fail variants — these are orthogonal
     to the lifecycle. They are parallel variants within a stage,
     not separate test categories.

  2. Observation follows action.
     show-tree after cases exist; show-trace after a run happened.
     A node that observes state should be a child of the node that
     creates it — it inherits the state to observe, no extra setup.

  3. State dependency drives hierarchy.
     If B needs A's state, B is a child of A.
     Siblings are independent — each starts from parent's committed
     state. This minimizes repeated precondition setup.

  4. Isolate broken/error cases.
     Put invalid specs in a separate subtree so they don't pollute
     the main validation flow.

Example (self-test bootstrap tree):
  bootstrap/
    spec.yaml              init project + install SUT
    validate-fresh/        validate initial state
    add-specs/             copy all spec trees at once
      validate/            validate all specs
      run-all/             run → expect pass + fail + skip
      run-with-trace/      run with trace → show trace
      show-tree/           tree shows all specs
      add-bad-spec/        broken spec (isolated)
        validate-rejects/  validate → error
      add-no-primary/     branches without primary → error

For details:
  treespec run --help       — spec format, assert types, wait, postcon, examples
  treespec show --help      — trace format, field reference, jq queries
  treespec validate --help  — validation rules, common errors
  treespec tree --help      — tree output format
  treespec lineage --help   — primary path, scope modes, detail levels
  treespec init --help      — scaffold structure
  treespec clean --help     — tag naming, cleanup scope