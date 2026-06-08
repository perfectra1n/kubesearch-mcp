# kubesearch-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM search
[kubesearch.dev](https://kubesearch.dev) — a search engine over **Flux HelmReleases**
and **Argo Applications** across hundreds of public "home-ops" Kubernetes Git
repositories.

It reproduces all of kubesearch.dev's search modes as tools:

| Tool | kubesearch.dev equivalent | What it does |
| --- | --- | --- |
| `search_helm_releases` | `/#cert-manager` | Find charts by name; see who deploys them, ranked by popularity. |
| `get_helm_release` | `/hr/<id>` | Every deployment of one chart, optionally with each repo's `spec.values`. |
| `search_images` | `/image#image cert-manager` | Container image repositories and the tags used in the wild. |
| `grep_values` | `/grep#grep cert-manager.io` | Full-text grep across real-world Helm values for config examples. |
| `kubesearch_status` | — | Report the cached data's release date and row counts. |

## How it works

kubesearch.dev has no live API; it publishes its index as SQLite databases on the
[`whazor/k8s-at-home-search`](https://github.com/whazor/k8s-at-home-search) GitHub
releases (a new date-tagged release daily). This server downloads and caches those
databases locally and queries them with SQL — fast, offline-capable, and identical to
what the website shows. Two complementary databases are used and joined on the YAML
file URL:

- `repos.db` (~7 MB) — chart/release/repo metadata.
- `repos-extended.db` (~37 MB) — the `spec.values` JSON (powers grep and image search).

Data is refreshed automatically when a newer daily release appears (see
`KUBESEARCH_REFRESH_HOURS`).

## Quick start (local, stdio)

```bash
npm install
npm run build
```

Add it to Claude Code:

```bash
claude mcp add kubesearch -- node /absolute/path/to/kubesearch-mcp/dist/index.js
```

Or in a Claude Desktop / MCP client config:

```json
{
  "mcpServers": {
    "kubesearch": {
      "command": "node",
      "args": ["/absolute/path/to/kubesearch-mcp/dist/index.js"]
    }
  }
}
```

The first call downloads the databases into the cache dir (a few seconds); subsequent
runs reuse the cache.

## Docker deployment (HTTP)

The image defaults to the **Streamable HTTP** transport, which is what you want for a
long-running server that MCP clients connect to over the network.

```bash
docker build -t kubesearch-mcp .
docker run -d --name kubesearch-mcp \
  -p 3000:3000 \
  -v kubesearch-data:/data \
  -e GITHUB_TOKEN=ghp_xxx \
  kubesearch-mcp
```

Or with Compose:

```bash
docker compose up -d
```

The MCP endpoint is `http://<host>:3000/mcp`; there's a `GET /healthz` for health
checks. Point an MCP client at it:

```json
{
  "mcpServers": {
    "kubesearch": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer <MCP_AUTH_TOKEN>" }
    }
  }
}
```

(The `Authorization` header is only required when `MCP_AUTH_TOKEN` is set.)

### Running the container over stdio instead

If you prefer to have a client spawn the container per session:

```bash
docker run -i --rm -v kubesearch-data:/data -e MCP_TRANSPORT=stdio kubesearch-mcp
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` (`http` in Docker) | `stdio` or `http`. |
| `MCP_HTTP_HOST` | `0.0.0.0` | HTTP bind host (http transport). |
| `MCP_HTTP_PORT` / `PORT` | `3000` | HTTP listen port (http transport). |
| `MCP_AUTH_TOKEN` | _(unset)_ | If set, every HTTP request must send `Authorization: Bearer <token>`. |
| `KUBESEARCH_CACHE_DIR` | `~/.cache/kubesearch-mcp` (`/data` in Docker) | Where the SQLite databases are cached. |
| `KUBESEARCH_REFRESH_HOURS` | `24` | How often to check for a newer daily release. `0` disables refresh (use cache forever). |
| `GITHUB_TOKEN` | _(unset)_ | Lifts the GitHub API rate limit (60→5000/hr) used to resolve the latest release. Recommended. |
| `KUBESEARCH_UPSTREAM_REPO` | `whazor/k8s-at-home-search` | Source repo for the databases (override only for forks/testing). |

## Development

```bash
npm run dev          # run from source via tsx
npm run typecheck    # tsc --noEmit
npm test             # vitest (unit + offline integration against a fixture DB)
npm run build        # bundle to dist/ with tsup
node scripts/smoke.mjs   # end-to-end: spawns the server over stdio and calls every tool
```

Tests run fully offline using a small in-memory fixture database that mirrors the real
schema; the `releaseKey`/`mergeHelmURL` slug logic is ported verbatim from upstream and
locked with test vectors so generated `/hr/<id>` links match the real site.

## Credits

All data comes from [kubesearch.dev](https://kubesearch.dev) /
[`whazor/k8s-at-home-search`](https://github.com/whazor/k8s-at-home-search). To include
your own cluster, make the repo public and add the `k8s-at-home` or `kubesearch` GitHub
topic.

## License

MIT
