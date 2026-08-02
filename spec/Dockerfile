FROM node:22-alpine

# Docker + fuse-overlayfs for DinD (Docker-in-Docker)
# fuse-overlayfs properly handles file permissions (unlike vfs)
RUN apk add --no-cache docker fuse-overlayfs fuse

WORKDIR /app

# Pure runtime: project source, node_modules, and dist are mounted from host.
# Add node_modules/.bin to PATH so project dependencies' CLIs are directly callable.
ENV PATH="/app/node_modules/.bin:$PATH"

# Static wrapper for the project's own CLI (not in node_modules/.bin at runtime,
# since the project isn't a dependency of itself).
RUN echo '#!/bin/sh' > /usr/local/bin/treespec && \
    echo 'exec node /app/dist/index.js "$@"' >> /usr/local/bin/treespec && \
    chmod +x /usr/local/bin/treespec
