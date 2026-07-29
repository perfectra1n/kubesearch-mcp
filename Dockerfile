# syntax=docker/dockerfile:1

# ---- build stage ----
FROM node:24-bookworm-slim AS build
WORKDIR /app

# Toolchain for compiling the better-sqlite3 native addon if no prebuilt binary
# is available for this platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
# Prune the native addon's build tree: when no prebuilt binary matches (the
# arm64/QEMU leg), better-sqlite3 compiles from source and keeps the object
# files and the bundled SQLite amalgamation, which are tens of MB of pure
# build-time weight. The require() proves the loadable .node survived.
RUN npm run build \
  && npm prune --omit=dev \
  && rm -rf node_modules/better-sqlite3/build/Release/obj.target \
            node_modules/better-sqlite3/build/deps \
            node_modules/better-sqlite3/deps \
            node_modules/better-sqlite3/src \
            node_modules/better-sqlite3/prebuilds \
  && node -e "require('better-sqlite3'); console.log('better-sqlite3 loads')"

# ---- runtime stage ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# `git` is required by the repo_clone tools; ca-certificates for TLS.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# MCP_HTTP_PORT is deliberately not set: the code already defaults to 3000, and
# pinning it here would override a PaaS-injected PORT.
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    KUBESEARCH_CACHE_DIR=/data \
    KUBESEARCH_REFRESH_HOURS=24

# Persistent cache for the downloaded SQLite databases (survives restarts).
# No VOLUME declaration: it would mint an anonymous volume on every `docker run`
# without -v. Mount /data explicitly to keep the cache across restarts.
RUN mkdir -p /data && chown node:node /data

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
COPY --chmod=755 docker/healthcheck.sh /usr/local/bin/healthcheck

USER node
EXPOSE 3000

# Liveness only (see /readyz for readiness). No-ops under the stdio transport,
# which has no port to probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["healthcheck"]

CMD ["node", "dist/index.js"]
