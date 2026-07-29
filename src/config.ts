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
  /** Accepted bearer tokens (HTTP transport). Empty means auth is disabled. */
  authTokens: string[];
  /** Max bytes accepted in a single HTTP request body. */
  maxBodyBytes: number;
  /** Close an HTTP session after this long without a request. */
  sessionTtlMs: number;
  /** Refuse new HTTP sessions beyond this many concurrent ones. */
  maxSessions: number;
  /** When non-empty, only these browser Origins may call /mcp. */
  allowedOrigins: string[];
  /** When non-empty, the Host header must match one of these (DNS-rebinding guard). */
  allowedHosts: string[];
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
  /** Overall wall-clock limit (ms) for downloading one database asset. */
  downloadTimeoutMs: number;
  /** Reject database downloads larger than this many bytes. */
  maxDbBytes: number;
  /** Repository clone/review feature. */
  clone: CloneConfig;
}

export interface CloneConfig {
  /** Whether the temporary git-clone tools are enabled. */
  enabled: boolean;
  /** Allowlist of git hostnames; empty means any (public) host. */
  allowedHosts: string[];
  /** Permit cloning from private/loopback/link-local/metadata addresses (SSRF guard off). */
  allowPrivate: boolean;
  /** Directory where ephemeral clones live. */
  dir: string;
  /** Auto-remove a clone after this many minutes of inactivity. */
  ttlMs: number;
  /** On a repeat clone of the same repo, `git fetch` + reset to the latest tip. */
  refreshOnClone: boolean;
  /** Max number of concurrent cached clones (LRU-evicted). */
  maxRepos: number;
  /** Reject/clean a clone whose working tree exceeds this size. */
  maxBytes: number;
  /** Hard timeout for the `git clone` subprocess. */
  timeoutMs: number;
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

function parseBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  throw new Error(`Invalid boolean env value: "${value}"`);
}

function parseListEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
}

/** Like parseListEnv but case-preserving — bearer tokens are case-sensitive. */
function parseTokensEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const refreshHours = parseIntEnv(env.KUBESEARCH_REFRESH_HOURS, 24);
  // 0 (or negative) disables refreshing: cached data is used forever once present.
  const autoRefresh = refreshHours > 0;
  const cacheDir =
    env.KUBESEARCH_CACHE_DIR && env.KUBESEARCH_CACHE_DIR.trim() !== "" ? env.KUBESEARCH_CACHE_DIR : defaultCacheDir();
  const clone: CloneConfig = {
    enabled: parseBoolEnv(env.KUBESEARCH_ENABLE_CLONE, true),
    allowedHosts: parseListEnv(env.KUBESEARCH_CLONE_ALLOWED_HOSTS),
    allowPrivate: parseBoolEnv(env.KUBESEARCH_CLONE_ALLOW_PRIVATE, false),
    dir:
      env.KUBESEARCH_CLONE_DIR && env.KUBESEARCH_CLONE_DIR.trim() !== ""
        ? env.KUBESEARCH_CLONE_DIR
        : path.join(cacheDir, "clones"),
    ttlMs: parseIntEnv(env.KUBESEARCH_CLONE_TTL_MINUTES, 30) * 60 * 1000,
    refreshOnClone: parseBoolEnv(env.KUBESEARCH_CLONE_REFRESH_ON_CLONE, true),
    maxRepos: parseIntEnv(env.KUBESEARCH_CLONE_MAX_REPOS, 5),
    maxBytes: parseIntEnv(env.KUBESEARCH_CLONE_MAX_MB, 200) * 1024 * 1024,
    timeoutMs: parseIntEnv(env.KUBESEARCH_CLONE_TIMEOUT_SECONDS, 120) * 1000,
  };
  return {
    transport: parseTransport(env.MCP_TRANSPORT),
    host: env.MCP_HTTP_HOST ?? "0.0.0.0",
    port: parseIntEnv(env.MCP_HTTP_PORT ?? env.PORT, 3000),
    authTokens: parseTokensEnv(env.MCP_AUTH_TOKEN),
    maxBodyBytes: parseIntEnv(env.MCP_MAX_BODY_BYTES, 4 * 1024 * 1024),
    sessionTtlMs: parseIntEnv(env.MCP_SESSION_TTL_MINUTES, 30) * 60 * 1000,
    maxSessions: parseIntEnv(env.MCP_MAX_SESSIONS, 100),
    allowedOrigins: parseListEnv(env.MCP_ALLOWED_ORIGINS),
    allowedHosts: parseListEnv(env.MCP_ALLOWED_HOSTS),
    cacheDir,
    refreshTtlMs: (autoRefresh ? refreshHours : 24) * 60 * 60 * 1000,
    autoRefresh,
    githubToken: env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim() !== "" ? env.GITHUB_TOKEN : undefined,
    upstreamRepo: env.KUBESEARCH_UPSTREAM_REPO && env.KUBESEARCH_UPSTREAM_REPO.trim() !== "" ? env.KUBESEARCH_UPSTREAM_REPO : "whazor/k8s-at-home-search",
    downloadTimeoutMs: parseIntEnv(env.KUBESEARCH_DOWNLOAD_TIMEOUT_SECONDS, 300) * 1000,
    maxDbBytes: parseIntEnv(env.KUBESEARCH_MAX_DB_MB, 512) * 1024 * 1024,
    clone,
  };
}
