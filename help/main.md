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
  image:
    dockerfile: tests/Dockerfile
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
  --no-trace           Skip trace JSONL output
  --verbose, -v        Show full step output
  --no-mount           Specs in image (skip bind mount, for DinD)
  --keep-tags          Keep ephemeral tags after run (debug)
  --rebuild            Force rebuild base image

For details:
  treespec run --help       — spec format, assert types, wait, postcon, examples
  treespec show --help      — trace format, field reference, jq queries
  treespec validate --help  — validation rules, common errors
  treespec tree --help      — tree output format
  treespec init --help      — scaffold structure
  treespec clean --help     — tag naming, cleanup scope