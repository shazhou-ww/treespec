treespec clean — remove ephemeral image tags

Usage: treespec clean

Removes all Docker images tagged `treespec/ephemeral:*`.
These are created during `treespec run` for the docker commit chain.
Normally cleaned up automatically after each run (unless --keep-tags).

Use when:
  - A run was interrupted (Ctrl+C) and left dangling tags
  - --keep-tags was used and you want to clean up later
  - Debugging and want a clean state

Exit code: always 0 (no tags = success, "No ephemeral tags to remove").