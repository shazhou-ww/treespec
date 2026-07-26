treespec init — create a project scaffold

Usage: treespec init <path>

Creates:
  <path>/
    treespec.yaml              # minimal config (image.dockerfile, image.tag, specs)
    tests/
      Dockerfile               # FROM node:22-alpine placeholder
      example/
        spec.yaml              # example: exec + regex assert

The scaffold is ready to run with `treespec run` after customizing the Dockerfile.
Non-interactive — just creates files. Fails if treespec.yaml already exists.