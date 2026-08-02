FROM node:22-alpine

WORKDIR /app

# Bake the tool itself (dist, deps, help docs) into the image so child containers
# created via `docker commit` can run `treespec` even with --no-mount.
# Project data (spec/, treespec.yaml, source) is NOT included — mounted at runtime.
COPY dist/ ./dist/
COPY node_modules/ ./node_modules/
COPY package.json ./
COPY help/ ./help/

# Add node_modules/.bin to PATH so project dependencies' CLIs are directly callable.
ENV PATH="/app/node_modules/.bin:$PATH"

# Static wrapper for the project's own CLI (not in node_modules/.bin at runtime,
# since the project isn't a dependency of itself).
RUN echo '#!/bin/sh' > /usr/local/bin/treespec && \
    echo 'exec node /app/dist/index.js "$@"' >> /usr/local/bin/treespec && \
    chmod +x /usr/local/bin/treespec
