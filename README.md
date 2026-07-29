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

All search tools are annotated read-only and return a typed `structuredContent`
payload alongside the equivalent text. They page with `limit`/`offset` and report
`has_more`, and their result ordering is global (matches are ranked across the whole
result set before the page is cut), so paging never repeats or skips an entry.

In the `values` view, `value_paths` accepts the paths printed in the `summary` view's
`common_settings` verbatim, array forms like `route.hostnames[]` included. A single
deployment whose config is too large for one response is always returned when it is
first on the page, so `{ repo, limit: 1 }` reaches any deployment; larger ones later in
a page are reported individually via `values_omitted` and `omitted_count`.

### Repository review tools (enabled by default; set `KUBESEARCH_ENABLE_CLONE=false` to disable)

| Tool | What it does |
| --- | --- |
| `repo_clone` | Temporarily clone a repo (indexed `owner/repo` **or** an https Git URL) and return a `handle` + a curated file tree. |
| `repo_list_files` | List files in a clone (optional sub-path + glob). |
| `repo_read_file` | Read a text file from a clone (binary refused, large files truncated). |
| `repo_grep` | Substring-search a clone's text files; returns `path:line` matches. Takes `limit` and `case_sensitive`. |
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

Concurrent `repo_clone` calls for the same repo share a single `git` invocation, at most
`KUBESEARCH_CLONE_MAX_CONCURRENT` git subprocesses run at once, and clone directories
stranded by an ungraceful restart are reaped at startup.

### Prompts (workflow shortcuts)

Server-provided MCP prompts that chain the tools: `kubesearch_compare_deployments`,
`kubesearch_adopt_chart`, `kubesearch_find_config_examples`, `kubesearch_pick_image`, and
(when cloning is enabled) `kubesearch_review_repo`.

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
docker run -d --name kubesearch-mcp \
  -p 3000:3000 \
  -v kubesearch-data:/data \
  -e GITHUB_TOKEN=ghp_xxx \
  ghcr.io/perfectra1n/kubesearch-mcp:latest
```

Published tags: `latest` (default branch), `vX.Y.Z` and `X.Y` (releases), and
`sha-<short>` for a specific commit. To build it yourself instead, use
`docker build -t kubesearch-mcp .` and substitute that image name.

Mount `/data` as shown: it holds the cached databases, so without it every restart
re-downloads ~44 MB.

Or with Compose:

```bash
docker compose up -d
```

> The container runs as the unprivileged `node` user (uid 1000) and writes cached
> databases and clones under `/data`. The named volume in `docker-compose.yml` is
> writable out of the box. If you bind-mount a host directory instead, make it writable
> by uid 1000 (e.g. `chown -R 1000:1000 ./data`), or `repo_clone` and refreshes will fail
> with "Permission denied".

The MCP endpoint is `http://<host>:3000/mcp`. Two health endpoints are exposed:

- `GET /healthz` — **liveness**. Always 200 while the process is up. This is what the
  image's `HEALTHCHECK` uses, so a slow initial download can't get the container
  restarted mid-download.
- `GET /readyz` — **readiness**. 503 until a release is loaded, then 200. Use this for
  Kubernetes readiness probes and load-balancer checks, so traffic isn't sent to a pod
  whose first queries would fail.

Point an MCP client at it:

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

### Securing the HTTP transport

**The HTTP transport ships open.** Out of the box there is no authentication, CORS is
`*`, and the image binds `0.0.0.0`. That is fine on a trusted network or behind a
reverse proxy that authenticates for you; it is not fine on a public interface. Before
exposing the port beyond a network you control:

| Variable | Default | What it does |
| --- | --- | --- |
| `MCP_AUTH_TOKEN` | _(unset — auth off)_ | Require `Authorization: Bearer <token>`. Accepts a comma-separated list, e.g. one token per client. |
| `MCP_ALLOWED_ORIGINS` | _(unset — any origin)_ | Comma-separated `Origin` allowlist. When set, CORS reflects only these origins and other browser callers get 403. Requests with no `Origin` (normal MCP clients) are unaffected. |
| `MCP_ALLOWED_HOSTS` | _(unset — any host)_ | Comma-separated `Host` allowlist. Guards against DNS rebinding, which matters for an instance reachable from a browser. |
| `MCP_MAX_SESSIONS` | `100` | Refuse new sessions past this many concurrent ones. |
| `MCP_MAX_BODY_BYTES` | `4194304` | Reject larger request bodies with 413. |

The server logs a warning at startup if it binds a non-loopback address with
authentication disabled. Terminate TLS at a proxy; the server speaks plain HTTP.

### Running the container over stdio instead

If you prefer to have a client spawn the container per session:

```bash
docker run -i --rm -v kubesearch-data:/data -e MCP_TRANSPORT=stdio kubesearch-mcp
```

## Configuration

All configuration is via environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` (`http` in Docker) | `stdio` or `http` (`streamable-http` and `streamablehttp` are accepted aliases). |
| `MCP_HTTP_HOST` | `0.0.0.0` | HTTP bind host (http transport). |
| `MCP_HTTP_PORT` / `PORT` | `3000` | HTTP listen port. `MCP_HTTP_PORT` wins if both are set; the image sets neither, so a PaaS-injected `PORT` is honoured. |
| `MCP_AUTH_TOKEN` | _(unset — auth off)_ | If set, every HTTP request must send `Authorization: Bearer <token>`. Accepts a single token or a comma-separated list of accepted tokens (e.g. one per client). |
| `MCP_ALLOWED_ORIGINS` | _(unset — any)_ | `Origin` allowlist for `/mcp`; see [Securing the HTTP transport](#securing-the-http-transport). |
| `MCP_ALLOWED_HOSTS` | _(unset — any)_ | `Host` allowlist for `/mcp` (DNS-rebinding guard). |
| `MCP_MAX_BODY_BYTES` | `4194304` | Max HTTP request body size; larger bodies get 413. |
| `MCP_MAX_SESSIONS` | `100` | Max concurrent HTTP sessions; further `initialize` calls get 503. |
| `MCP_SESSION_TTL_MINUTES` | `30` | Close an HTTP session after this long with no requests. |
| `LOG_LEVEL` | `info` | Minimum log severity to emit: `debug`, `info`, `warn`, or `error`. All logs are unstructured text on stderr. |
| `KUBESEARCH_CACHE_DIR` | `~/.cache/kubesearch-mcp` (`/data` in Docker) | Where the SQLite databases are cached. |
| `KUBESEARCH_REFRESH_HOURS` | `24` | How often to check for a newer daily release. `0` disables refresh (use cache forever). A failed check retries on a short backoff rather than waiting the full interval. |
| `KUBESEARCH_DOWNLOAD_TIMEOUT_SECONDS` | `300` | Wall-clock limit for downloading one database. Downloads also abort after 30s with no data received. |
| `KUBESEARCH_MAX_DB_MB` | `512` | Reject a database download larger than this. |
| `GITHUB_TOKEN` | _(unset)_ | Lifts the GitHub API rate limit (60→5000/hr) used to resolve the latest release. Recommended. |
| `KUBESEARCH_UPSTREAM_REPO` | `whazor/k8s-at-home-search` | Source repo for the databases (override only for forks/testing). |
| `KUBESEARCH_ENABLE_CLONE` | `true` | Enable the `repo_*` clone/review tools. Set `false` to hide them entirely. |
| `KUBESEARCH_CLONE_ALLOWED_HOSTS` | _(any)_ | Comma-separated host allowlist, e.g. `github.com,gitlab.com`. Empty = any public host. |
| `KUBESEARCH_CLONE_ALLOW_PRIVATE` | `false` | Permit cloning from private/loopback/link-local/metadata addresses (SSRF guard off). |
| `KUBESEARCH_CLONE_DIR` | `<cacheDir>/clones` | Where ephemeral clones live. |
| `KUBESEARCH_CLONE_TTL_MINUTES` | `30` | Auto-delete a clone after this much inactivity (timer resets on each access). |
| `KUBESEARCH_CLONE_REFRESH_ON_CLONE` | `true` | On a repeat clone of the same repo, `git fetch` + reset to the latest commit. |
| `KUBESEARCH_CLONE_MAX_REPOS` | `5` | Max concurrent cached clones (LRU-evicted). |
| `KUBESEARCH_CLONE_MAX_CONCURRENT` | `2` | Max `git` subprocesses running at once. |
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

Tests run fully offline against a small fixture database that mirrors the real schema.
They cover the domain logic, the download/refresh paths (with a stubbed `fetch`), the
HTTP transport end to end, and the tools themselves through an in-memory MCP client —
which means the SDK validates every response against its declared `outputSchema`. The
`releaseKey`/`mergeHelmURL` slug logic is ported verbatim from upstream and locked with
test vectors so generated `/hr/<id>` links match the real site.

`typecheck` and `test` run on every push and pull request, and the container image is
only published if they pass.

## Credits

All data comes from [kubesearch.dev](https://kubesearch.dev) /
[`whazor/k8s-at-home-search`](https://github.com/whazor/k8s-at-home-search). To include
your own cluster, make the repo public and add the `k8s-at-home` or `kubesearch` GitHub
topic.

## License

MIT
