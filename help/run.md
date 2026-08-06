treespec run — execute the test tree

Usage: treespec run [paths...] [options]

Paths: optional positional args (node paths or globs). If omitted, runs all.
  treespec run                    # run entire tree
  treespec run provider-add      # run subtree (auto-pulls ancestors)
  treespec run "provider-*"      # glob match

Options:
  --config <path>       Override treespec.yaml path
  --image <tag>         Use existing image as base (skip build)
  --rebuild             Force rebuild (requires image.dockerfile in config)
  --env-file <path>     Override .env path
  --output <path>       Output path (dir → timestamped, .jsonl → exact file)
  --no-trace            Skip writing trace JSONL
  --keep-tags           Keep ephemeral image tags after run
  --verbose, -v         Show full step output in terminal
  -h, --help            Show this help

For writing test cases, run: treespec docs writing-tests
For running tests details, run: treespec docs running-tests
