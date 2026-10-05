# Build from the repository root:  docker build -f web/Dockerfile .
FROM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY worker/package.json worker/
COPY web/package.json web/
RUN npm ci --workspace web
COPY tsconfig.base.json ./
COPY web web
RUN npm run build --workspace web

# The app is static files; nginx serves them and forwards /api to the api container.
FROM nginx:1.27-alpine
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
