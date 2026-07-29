/** Resolving the newest upstream release tag and building asset download URLs. */

import { HttpStatusError, isTransientStatus, withRetry, type RetryOptions } from "../util/retry.js";

export interface ReleaseAssets {
  tag: string;
  reposDbUrl: string;
  reposExtendedDbUrl: string;
}

export function assetUrls(repo: string, tag: string): ReleaseAssets {
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  return {
    tag,
    reposDbUrl: `${base}/repos.db`,
    reposExtendedDbUrl: `${base}/repos-extended.db`,
  };
}

function githubHeaders(token: string | undefined, etag: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "kubesearch-mcp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (etag) headers["If-None-Match"] = etag;
  return headers;
}

/** The previously-resolved release, enabling a conditional (free) API request. */
export interface PriorRelease {
  tag: string;
  etag: string;
}

export interface ResolvedRelease {
  tag: string;
  /** ETag of the release-list response, for the next conditional request. */
  etag: string | null;
  /** True when GitHub answered 304 and `tag` was carried over from `prior`. */
  notModified: boolean;
}

const API_TIMEOUT_MS = 10_000;

function apiRetryable(err: unknown): boolean {
  if (err instanceof HttpStatusError) return isTransientStatus(err.status);
  return true; // network failures and timeouts
}

/**
 * Resolve the newest release tag. The upstream releases are marked as
 * prereleases, so `releases/latest` 404s — we list releases (newest first) and
 * take the first one that actually has the `repos.db` asset.
 */
export async function resolveLatestTag(
  repo: string,
  token: string | undefined,
  prior?: PriorRelease,
  retry: RetryOptions = {},
): Promise<ResolvedRelease> {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=10`;
  return withRetry(async () => {
    const res = await fetch(url, {
      headers: githubHeaders(token, prior?.etag),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (res.status === 304 && prior) {
      return { tag: prior.tag, etag: prior.etag, notModified: true };
    }
    if (!res.ok) {
      const hint = res.status === 403 ? " (rate limited — set GITHUB_TOKEN to raise the limit)" : "";
      throw new HttpStatusError(`GitHub API ${res.status} resolving latest release for ${repo}${hint}`, res.status);
    }
    const etag = res.headers.get("etag");
    const releases = (await res.json()) as Array<{
      tag_name?: string;
      assets?: Array<{ name?: string }>;
    }>;
    if (!Array.isArray(releases) || releases.length === 0) {
      throw new Error(`No releases found for ${repo}`);
    }
    for (const release of releases) {
      const hasDb = release.assets?.some((a) => a.name === "repos.db");
      if (release.tag_name && hasDb) return { tag: release.tag_name, etag, notModified: false };
    }
    // Fallback: first tag even if asset listing was unexpected.
    const first = releases[0]?.tag_name;
    if (first) return { tag: first, etag, notModified: false };
    throw new Error(`No usable release tag for ${repo}`);
  }, { retryable: apiRetryable, ...retry });
}
