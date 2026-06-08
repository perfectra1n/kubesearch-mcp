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
RUN npm run build \
  && npm prune --omit=dev

# ---- runtime stage ----
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    MCP_TRANSPORT=http \
    MCP_HTTP_HOST=0.0.0.0 \
    MCP_HTTP_PORT=3000 \
    KUBESEARCH_CACHE_DIR=/data \
    KUBESEARCH_REFRESH_HOURS=24

# Persistent cache for the downloaded SQLite databases (survives restarts).
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

USER node
EXPOSE 3000

# Liveness/readiness against the built-in /healthz endpoint (http transport).
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.MCP_HTTP_PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
