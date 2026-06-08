/** Resolving the newest upstream release tag and building asset download URLs. */

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

function githubHeaders(token: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "kubesearch-mcp",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

/**
 * Resolve the newest release tag. The upstream releases are marked as
 * prereleases, so `releases/latest` 404s — we list releases (newest first) and
 * take the first one that actually has the `repos.db` asset.
 */
export async function resolveLatestTag(repo: string, token: string | undefined): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=10`;
  const res = await fetch(url, { headers: githubHeaders(token) });
  if (!res.ok) {
    const hint = res.status === 403 ? " (rate limited — set GITHUB_TOKEN to raise the limit)" : "";
    throw new Error(`GitHub API ${res.status} resolving latest release for ${repo}${hint}`);
  }
  const releases = (await res.json()) as Array<{
    tag_name?: string;
    assets?: Array<{ name?: string }>;
  }>;
  if (!Array.isArray(releases) || releases.length === 0) {
    throw new Error(`No releases found for ${repo}`);
  }
  for (const release of releases) {
    const hasDb = release.assets?.some((a) => a.name === "repos.db");
    if (release.tag_name && hasDb) return release.tag_name;
  }
  // Fallback: first tag even if asset listing was unexpected.
  const first = releases[0]?.tag_name;
  if (first) return first;
  throw new Error(`No usable release tag for ${repo}`);
}
