FROM node:22-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install dependencies (includes devDeps for tsc build)
RUN npm ci 2>/dev/null || npm install

# Copy source code
COPY . .

# Build TypeScript → dist/
RUN npx tsc

# Link the CLI globally
RUN npm link

# Create /specs symlink so --no-mount (DinD) can access tests via /specs path
# Outer run mounts over this; inner --no-mount uses the symlink
RUN ln -s /app/tests /specs

WORKDIR /app
