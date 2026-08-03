FROM node:22-alpine

# Docker + fuse-overlayfs for DinD (Docker-in-Docker)
# fuse-overlayfs properly handles file permissions (unlike vfs)
RUN apk add --no-cache docker fuse-overlayfs fuse

WORKDIR /app

# Pure runtime: project source, node_modules, and dist are mounted from host.
# Add node_modules/.bin to PATH so project dependencies' CLIs are directly callable.
ENV PATH="/app/node_modules/.bin:$PATH"

# dist/index.js has #!/usr/bin/env node shebang + execute permission (set by build).
# Symlink it so `treespec` is callable from anywhere.
RUN ln -s /app/dist/index.js /usr/local/bin/treespec
