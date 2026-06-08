# kubesearch-mcp

An [MCP](https://modelcontextprotocol.io) server that lets an LLM search
[kubesearch.dev](https://kubesearch.dev) — a search engine over **Flux HelmReleases**
and **Argo Applications** across hundreds of public "home-ops" Kubernetes Git
repositories.

It reproduces all of kubesearch.dev's search modes as tools, and can temporarily
clone a repo so the model can review its actual manifests.

### Search tools

| Tool | kubesearch.dev equivalent | What it does |
| --- | --- | --- |
| `kubesearch_search_releases` | `/#cert-manager` | Find charts by name; see who deploys them, ranked by popularity. |
| `kubesearch_get_release` | `/hr/<id>` | One chart's deployments. `view: "summary"` (default) digests the common `spec.values`; `view: "deployments"` paginates the repo list; `view: "values"` drills into a repo's full config. |
| `kubesearch_search_images` | `/image#image cert-manager` | Container image repositories and the tags used in the wild. |
| `kubesearch_grep_values` | `/grep#grep cert-manager.io` | Full-text grep across real-world Helm values for config examples. |
| `kubesearch_status` | — | Report the cached data's release date and row counts. |

All search tools are annotated read-only and return both human-readable text and a
typed `structuredContent` payload.

### Repository review tools (enabled by default; set `KUBESEARCH_ENABLE_CLONE=false` to disable)

| Tool | What it does |
| --- | --- |
| `repo_clone` | Temporarily clone a repo (indexed `owner/repo` **or** an https Git URL) and return a `handle` + a curated file tree. |
| `repo_list_files` | List files in a clone (optional sub-path + glob). |
| `repo_read_file` | Read a text file from a clone (binary refused, large files truncated). |
| `repo_grep` | Substring-search a clone's text files; returns `path:line` matches. |
| `repo_cleanup` | Delete a clone early (clones also auto-expire). |

Clones are **sandboxed**: shallow (`--depth 1`, blob-size filtered), run with `git` via
`execFile` (no shell) and a scrubbed environment, size/TTL/concurrency-capped, confined to
a per-clone temp dir, with path-traversal and symlink-escape protection. By default any
public host is allowed but private/loopback/link-local/metadata addresses are blocked (see
env vars below).

**Lifecycle:** a clone is kept while it's being used and auto-deleted after
`KUBESEARCH_CLONE_TTL_MINUTES` of **inactivity** (the timer resets on every access). Repeat
`repo_clone` calls for the same repo+branch are **deduplicated** to a single working copy and
(by default) **refreshed** with a shallow `git fetch` + hard reset to the latest commit, so a
long-lived clone never goes stale — set `KUBESEARCH_CLONE_REFRESH_ON_CLONE=false` to reuse
without pulling. Reads (`repo_read_file`/`repo_grep`/`repo_list_files`) are served from the
snapshot and do **not** pull, so an in-progress review stays stable; re-run `repo_clone` to pull.

### Prompts (workflow shortcuts)

Server-provided MCP prompts that chain the tools: `kubesearch_compare_deployments`,
`kubesearch_adopt_chart`, `kubesearch_find_config_examples`, and (when cloning is enabled)
`kubesearch_review_repo`.

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

> The container runs as the unprivileged `node` user (uid 1000) and writes cached
> databases and clones under `/data`. The named volume in `docker-compose.yml` is
> writable out of the box. If you bind-mount a host directory instead, make it writable
> by uid 1000 (e.g. `chown -R 1000:1000 ./data`), or `repo_clone` and refreshes will fail
> with "Permission denied".

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
| `KUBESEARCH_ENABLE_CLONE` | `true` | Enable the `repo_*` clone/review tools. Set `false` to hide them entirely. |
| `KUBESEARCH_CLONE_ALLOWED_HOSTS` | _(any)_ | Comma-separated host allowlist, e.g. `github.com,gitlab.com`. Empty = any public host. |
| `KUBESEARCH_CLONE_ALLOW_PRIVATE` | `false` | Permit cloning from private/loopback/link-local/metadata addresses (SSRF guard off). |
| `KUBESEARCH_CLONE_DIR` | `<cacheDir>/clones` | Where ephemeral clones live. |
| `KUBESEARCH_CLONE_TTL_MINUTES` | `30` | Auto-delete a clone after this much inactivity (timer resets on each access). |
| `KUBESEARCH_CLONE_REFRESH_ON_CLONE` | `true` | On a repeat clone of the same repo, `git fetch` + reset to the latest commit. |
| `KUBESEARCH_CLONE_MAX_REPOS` | `5` | Max concurrent cached clones (LRU-evicted). |
| `KUBESEARCH_CLONE_MAX_MB` | `200` | Reject/clean a clone whose tree exceeds this size. |
| `KUBESEARCH_CLONE_TIMEOUT_SECONDS` | `120` | Hard timeout for the `git clone` subprocess. |

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
