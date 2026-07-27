treespec init — create a project scaffold

Usage: treespec init <path> [--name <name>]

Options:
  --name <name>   Override test suite name (default: directory name from path)
  -h, --help      Show this help

Creates:
  <path>/
    treespec.yaml              # minimal config (name, image, specs)
    tests/
      Dockerfile               # FROM node:22-alpine placeholder
      example/
        spec.yaml              # example: exec + regex assert

The name field defaults to the path's directory name, or use --name to override.
Image tag defaults to <name>-test:base (can be overridden).
The scaffold is ready to run with `treespec run` after customizing the Dockerfile.
Non-interactive — just creates files. Fails if treespec.yaml already exists.