# Build from the repository root:  docker build --platform linux/amd64 -f worker/Dockerfile .
FROM node:20-bookworm-slim

# Blender 4.5 LTS: the official Linux build, pinned by version and SHA-256 (from
# blender-4.5.14.sha256 as published with the release). Official builds exist for x86-64 only.
# download.blender.org turns away scripted downloads, so this fetches from one of the mirrors
# blender.org lists; the checksum is what guarantees the content.
ARG BLENDER_VERSION=4.5.14
ARG BLENDER_SHA256=9ba871ff2ecd36526b77432745980b7e6664ecd0c7ca11c48849073dcfe06da3
ARG BLENDER_URL=https://mirrors.ocf.berkeley.edu/blender/release/Blender4.5/blender-${BLENDER_VERSION}-linux-x64.tar.xz

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
      # what Blender links against, plus Mesa's software OpenGL so EEVEE can render without a GPU
      libgl1 libegl1 libgl1-mesa-dri libglx-mesa0 libxi6 libxxf86vm1 libxfixes3 libxrender1 \
      libxkbcommon0 libsm6 libice6 libx11-6 libxext6 \
 && curl -fsSL "$BLENDER_URL" -o /tmp/blender.tar.xz \
 && echo "$BLENDER_SHA256  /tmp/blender.tar.xz" | sha256sum -c - \
 && mkdir -p /opt/blender \
 && tar -xJf /tmp/blender.tar.xz -C /opt/blender --strip-components=1 \
 && rm /tmp/blender.tar.xz \
 && rm -rf /var/lib/apt/lists/*
ENV BLENDER_BIN=/opt/blender/blender

WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY api/package.json api/
COPY worker/package.json worker/
COPY web/package.json web/
RUN npm ci --workspace worker --workspace shared --omit=dev \
 # Chromium, and the system libraries it needs, for rendering splat turntables.
 && npx playwright install --with-deps chromium \
 && rm -rf /var/lib/apt/lists/*

COPY tsconfig.base.json ./
COPY shared shared
COPY worker worker

WORKDIR /app/worker
CMD ["../node_modules/.bin/tsx", "src/index.ts"]
