import os from "node:os";
import path from "node:path";

/**
 * Runtime configuration, all sourced from environment variables so the server
 * is fully configurable in a container deployment.
 */
export interface Config {
  /** Transport: "stdio" (default) or "http" (Streamable HTTP for container deploys). */
  transport: "stdio" | "http";
  /** HTTP listen host (http transport only). */
  host: string;
  /** HTTP listen port (http transport only). */
  port: number;
  /** Optional bearer token required on HTTP requests when set. */
  authToken: string | undefined;
  /** Directory where the downloaded SQLite databases are cached. */
  cacheDir: string;
  /** How long (ms) a cached database is trusted before re-checking for a newer release. */
  refreshTtlMs: number;
  /** Whether to auto-refresh at all (false when KUBESEARCH_REFRESH_HOURS <= 0). */
  autoRefresh: boolean;
  /** Optional GitHub token to lift the 60 req/hr anonymous API rate limit. */
  githubToken: string | undefined;
  /** Upstream repo that publishes the databases. */
  upstreamRepo: string;
}

function defaultCacheDir(): string {
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".cache");
  return path.join(base, "kubesearch-mcp");
}

function parseTransport(value: string | undefined): "stdio" | "http" {
  const v = (value ?? "").toLowerCase();
  if (v === "http" || v === "streamable-http" || v === "streamablehttp") return "http";
  if (v === "stdio" || v === "") return "stdio";
  throw new Error(`Invalid MCP_TRANSPORT="${value}" (expected "stdio" or "http")`);
}

function parseIntEnv(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error(`Invalid numeric env value: "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const refreshHours = parseIntEnv(env.KUBESEARCH_REFRESH_HOURS, 24);
  // 0 (or negative) disables refreshing: cached data is used forever once present.
  const autoRefresh = refreshHours > 0;
  return {
    transport: parseTransport(env.MCP_TRANSPORT),
    host: env.MCP_HTTP_HOST ?? "0.0.0.0",
    port: parseIntEnv(env.MCP_HTTP_PORT ?? env.PORT, 3000),
    authToken: env.MCP_AUTH_TOKEN && env.MCP_AUTH_TOKEN.trim() !== "" ? env.MCP_AUTH_TOKEN : undefined,
    cacheDir: env.KUBESEARCH_CACHE_DIR && env.KUBESEARCH_CACHE_DIR.trim() !== "" ? env.KUBESEARCH_CACHE_DIR : defaultCacheDir(),
    refreshTtlMs: (autoRefresh ? refreshHours : 24) * 60 * 60 * 1000,
    autoRefresh,
    githubToken: env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== "" ? env.GITHUB_TOKEN : undefined,
    upstreamRepo: env.KUBESEARCH_UPSTREAM_REPO && env.KUBESEARCH_UPSTREAM_REPO.trim() !== "" ? env.KUBESEARCH_UPSTREAM_REPO : "whazor/k8s-at-home-search",
  };
}
