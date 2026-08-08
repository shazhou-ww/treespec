treespec {{version}} — tree-structured, stateful test system

Directory tree = test tree. Each folder with spec.yaml = a test case.
State passes parent→child via `docker commit`. DFS traversal, failure pruning.

Commands:
  treespec run [paths...] [options]   DFS-execute the test tree (or subtrees)
  treespec show <trace.jsonl>         Replay a trace as human-readable output
  treespec validate [--config <path>] Check config + spec tree for errors
  treespec tree [--config <path>]     Visualize the full test tree structure
  treespec lineage [node] [options]  Show the primary descent line
  treespec init <path>                Create a project scaffold
  treespec clean                      Remove all ephemeral image tags
  treespec docs [scenario]           Detailed documentation by scenario

Common flags:
  --image <tag>        Use existing image (skip build)
  --config <path>      Override treespec.yaml path
  --output <path>      Output path (dir → timestamped, .jsonl → exact file)
  --no-trace           Skip trace JSONL output
  --verbose, -v        Show full step output
  --keep-tags          Keep ephemeral tags after run (debug)
  --rebuild            Force rebuild base image

Minimal spec.yaml:
  description: "echo hello"
  steps:
    - type: exec
      command: "echo hello"
      assert:
        type: regex
        conditions:
          - { path: "stdout", regex: "hello" }

For detailed documentation, run: treespec docs
