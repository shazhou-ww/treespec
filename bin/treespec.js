#!/bin/sh
# treespec CLI wrapper
# Resolve symlink (npm link) to find actual script location
DIR=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
exec node "$DIR/../dist/index.js" "$@"
