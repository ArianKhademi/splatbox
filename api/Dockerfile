# Build from the repository root:  docker build -f api/Dockerfile .
FROM node:20-bookworm-slim
WORKDIR /app

# Manifests first, so the dependency layer is reused until one of them changes. npm needs every
# workspace's package.json to validate the lockfile, even though only two are installed.
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY worker/package.json worker/
COPY web/package.json web/
RUN npm ci --workspace api --workspace shared --omit=dev

COPY tsconfig.base.json ./
COPY shared shared
COPY api api

WORKDIR /app/api
EXPOSE 4000
# The TypeScript sources run directly through tsx: no separate build step to keep in sync.
CMD ["../node_modules/.bin/tsx", "src/server.ts"]
