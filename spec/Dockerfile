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

# DinD init: use /dev/shm (tmpfs) for data-root — not captured by docker commit,
# so child containers start clean without "Resource busy" mount conflicts.
# fuse-overlayfs for nested containers (overlay2 doesn't work, vfs loses permissions).
# Clean stale runtime state from parent's committed layer before starting.
# Executor detects dind-init via Cmd shell wrapper — no ENTRYPOINT needed.
RUN printf '#!/bin/sh\nrm -rf /var/run/docker /var/run/docker.pid /var/run/docker.sock\ndockerd --storage-driver=fuse-overlayfs --data-root=/dev/shm/docker-data > /dev/null 2>&1 &\nfor i in $(seq 1 60); do\n  docker info > /dev/null 2>&1 && break\n  sleep 0.5\ndone\nexec "$@"\n' > /usr/local/bin/dind-init && \
    chmod +x /usr/local/bin/dind-init
