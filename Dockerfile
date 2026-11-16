# syntax=docker/dockerfile:1
#
# Nova: one image that serves the API, media streams and the web app on :3000.
#
#   docker build -t nova .                  # default target "server": this server streams torrents
#   docker build -t nova:client --target client .   # viewers' devices stream torrents; the server never joins a swarm
#
# Nothing needs configuring to start: the first boot creates an admin (its
# password is printed once) and a signing secret in /data. Content sources are
# plugins you install from the app (Server -> Plugins).
#
# Debian (glibc) rather than Alpine so better-sqlite3 uses its prebuilt binary.

# ---------- web app ----------
FROM node:22-bookworm-slim AS web
WORKDIR /web
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
RUN npm run build

# ---------- server ----------
FROM node:22-bookworm-slim AS build
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/tsconfig.json ./
COPY server/src ./src
# Compile TS -> dist/, then drop dev deps (keeps the compiled better-sqlite3).
RUN npm run build && npm prune --omit=dev

# ---------- runtime ----------
FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    TORRENT_DIR=/cache \
    LIBRARY_DIR=/library \
    WEB_DIR=/app/web \
    TZ=UTC
LABEL org.opencontainers.image.title="Nova" \
      org.opencontainers.image.description="Self-hosted movies, shows, anime, live TV and books with a plugin system." \
      org.opencontainers.image.licenses="MIT"
WORKDIR /app/server
COPY --from=build /server/node_modules /app/server/node_modules
COPY --from=build /server/package.json /app/server/package.json
COPY --from=build /server/dist /app/server/dist
COPY --from=web /web/dist /app/web
# /data: database, plugins, backups (keep it). /library: titles kept on the server.
# /cache: torrent scratch space, safe to lose.
RUN mkdir -p /data /cache /library && chown -R node:node /data /cache /library /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "dist/index.js"]

# Viewers stream torrents on their own device (the Nova desktop app, or the
# browser as a fallback); this server only finds sources and serves the app.
FROM runtime AS client
ENV TORRENT_MODE=client

# Default: the server downloads and streams torrents for everyone.
FROM runtime AS server
ENV TORRENT_MODE=server
