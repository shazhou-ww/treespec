FROM node:22-alpine

# Docker + fuse-overlayfs for DinD (Docker-in-Docker)
# fuse-overlayfs properly handles file permissions (unlike vfs)
RUN apk add --no-cache docker fuse-overlayfs fuse curl

# Project source, node_modules, and dist are mounted from host at runtime.
# bin/ has the `treespec` executable (#!/usr/bin/env node), node_modules/.bin has deps' CLIs.
# Symlink treespec → treespec.js (renamed for Windows compat, but specs call `treespec`)
RUN ln -s /app/bin/treespec.js /usr/local/bin/treespec

ENV PATH="/app/bin:/app/node_modules/.bin:$PATH"
