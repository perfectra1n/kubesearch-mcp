import type { Database } from "better-sqlite3";
import type { PoolConfig } from "../config.js";

export interface PoolMember {
  /** Indexed repo name, e.g. "onedr0p/home-ops". Doubles as the pool clone's handle. */
  repoName: string;
  url: string;
  branch: string | null;
  stars: number;
}

export interface PoolSelection {
  members: PoolMember[];
  /** Explicitly requested names that are not in the index (only populated for an explicit list). */
  unknown: string[];
}

interface Row {
  repo_name: string;
  url: string | null;
  branch: string | null;
  stars: number | null;
}

// Raw stars are a noisy signal: several of the most-starred indexed repos are
// CLI tools or Argo-only clusters with nothing greppable, so rank only among
// repos that actually carry HelmReleases.
const RANKED_QUERY = `
  select r.repo_name, r.url, r.branch, r.stars
  from repo r
  where r.url is not null
    and (select count(*) from flux_helm_release h where h.repo_name = r.repo_name) >= ?
  order by r.stars desc, r.repo_name
  limit ?
`;

const BY_NAME_QUERY = `select repo_name, url, branch, stars from repo where repo_name = ? and url is not null`;

function toMember(row: Row): PoolMember {
  return { repoName: row.repo_name, url: row.url!, branch: row.branch, stars: row.stars ?? 0 };
}

/**
 * Decide which repos the always-warm pool should hold: an explicit list when
 * configured (order preserved, unknown names reported), otherwise the top
 * `size` repos by stars among those with at least `minReleases` HelmReleases.
 */
export function selectPoolRepos(db: Database, cfg: PoolConfig): PoolSelection {
  if (cfg.repos.length > 0) {
    const stmt = db.prepare(BY_NAME_QUERY);
    const members: PoolMember[] = [];
    const unknown: string[] = [];
    for (const name of cfg.repos) {
      const row = stmt.get(name) as Row | undefined;
      if (row) members.push(toMember(row));
      else unknown.push(name);
    }
    return { members, unknown };
  }
  const rows = db.prepare(RANKED_QUERY).all(cfg.minReleases, cfg.size) as Row[];
  return { members: rows.map(toMember), unknown: [] };
}
