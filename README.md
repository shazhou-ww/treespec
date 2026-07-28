# treespec

> Tree-structured, stateful test system — state isolation via Docker commit chains, DFS traversal with failure pruning.

**Status: Design phase.** Spec document in `docs/DESIGN.md`.

## Concept

`treespec` is a tree-structured testing system where:

- **Nodes** = test cases (steps + assertions)
- **Edges** = state dependencies (child inherits parent's post-condition state)
- **State isolation** = Docker commit produces image tags as immutable state snapshots

Each test case file references its parent via relative path. The file system *is* the tree.

```yaml
# spec/provider/provider-add.yaml
name: provider-add
steps:
  - type: exec
    command: "myapp provider add openrouter"
    assert:
      type: regex
      conditions:
        - { path: stdout, regex: "added" }

# spec/provider/model-add.yaml
name: model-add
parent: ./provider-add.yaml
steps:
  - type: exec
    command: "myapp model add claude-4-sonnet --provider openrouter"
```

## Why

- **State reuse** — a setup runs once, all descendants inherit the resulting state
- **Failure pruning** — a failed node prunes its entire subtree
- **Resource control** — DFS traversal keeps only current-path image tags in memory

## License

MIT © Shazhou Family
