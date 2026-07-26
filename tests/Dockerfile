FROM node:22-alpine

WORKDIR /app

# Copy package files first for layer caching
COPY package.json package-lock.json* ./

# Install dependencies + tsx globally (for bin/treespec.js wrapper)
RUN npm ci 2>/dev/null || npm install
RUN npm install -g tsx

# Copy source code
COPY . .

# Link the CLI globally
RUN npm link

WORKDIR /app
