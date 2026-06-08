import type { Database } from "better-sqlite3";
import { mergeHelmURL, releaseKey } from "./releaseKey.js";
import type { Deployment, ReleaseGroup, ReleaseIndex } from "./types.js";

/**
 * The 3-branch UNION query, mirrored from upstream
 * web/src/generators/helm-release/generator.ts (with `namespace` added so the
 * detail view can show it). Runs against the metadata database (`repos.db`).
 */
const COLLECTOR_QUERY = `
  select
    hrep.helm_repo_url as helm_repo_url,
    hrep.helm_repo_name as helm_repo_name,
    rel.chart_name, rel.chart_version, rel.release_name, rel.namespace,
    rel.url, rel.repo_name, rel.hajimari_icon, rel.hajimari_group, rel.timestamp,
    repo.stars, repo.url as repo_url
  from flux_helm_release rel
  join flux_helm_repo hrep
    on rel.helm_repo_name = hrep.helm_repo_name
    and rel.helm_repo_namespace = hrep.namespace
    and rel.repo_name = hrep.repo_name
    and (rel.chart_ref_kind = 'HelmRepository' or rel.chart_ref_kind = 'GitRepository')
  join repo repo on rel.repo_name = repo.repo_name
  group by rel.url

  union all

  select
    flor.url as helm_repo_url,
    flor.name as helm_repo_name,
    rel.chart_name, rel.chart_version, rel.release_name, rel.namespace,
    rel.url, rel.repo_name, rel.hajimari_icon, rel.hajimari_group, rel.timestamp,
    repo.stars, repo.url as repo_url
  from flux_helm_release rel
  join flux_oci_repository flor
    on rel.helm_repo_name = flor.name
    and rel.chart_ref_kind = 'OCIRepository'
    and (flor.namespace = rel.helm_repo_namespace
         or (rel.helm_repo_namespace is null
             and (flor.namespace is null or flor.namespace = 'flux-system')))
  join repo repo on rel.repo_name = repo.repo_name
  group by rel.url

  union all

  select
    rel.helm_repo_url as helm_repo_url,
    '' as helm_repo_name,
    rel.chart_name, rel.chart_version, rel.release_name, rel.namespace,
    rel.url, rel.repo_name, rel.hajimari_icon, rel.hajimari_group, rel.timestamp,
    repo.stars, repo.url as repo_url
  from argo_helm_application rel
  join repo repo on rel.repo_name = repo.repo_name
`;

interface CollectorRow {
  helm_repo_url: string | null;
  helm_repo_name: string | null;
  chart_name: string;
  chart_version: string | null;
  release_name: string;
  namespace: string | null;
  url: string;
  repo_name: string;
  hajimari_icon: string | null;
  hajimari_group: string | null;
  timestamp: string;
  stars: number | null;
  repo_url: string | null;
}

/** Build the full release-key index from the metadata database. */
export function buildReleaseIndex(db: Database): ReleaseIndex {
  const rows = db.prepare(COLLECTOR_QUERY).all() as CollectorRow[];
  const groups = new Map<string, ReleaseGroup>();
  const urlMeta = new Map<string, import("./types.js").UrlMeta>();

  for (const row of rows) {
    const mergedUrl = mergeHelmURL(row.helm_repo_url ?? "");
    const key = releaseKey(mergedUrl, row.chart_name, row.release_name);
    const stars = row.stars ?? 0;

    const deployment: Deployment = {
      key,
      chart: row.chart_name,
      release: row.release_name,
      namespace: row.namespace,
      chartVersion: row.chart_version,
      chartSourceUrl: mergedUrl,
      helmRepoName: row.helm_repo_name ?? "",
      repo: row.repo_name,
      repoUrl: row.repo_url,
      stars,
      fileUrl: row.url,
      timestamp: row.timestamp,
      icon: row.hajimari_icon,
      group: row.hajimari_group,
    };

    let group = groups.get(key);
    if (!group) {
      group = { id: key, chart: row.chart_name, chartSourceUrl: mergedUrl, deploymentCount: 0, deployments: [] };
      groups.set(key, group);
    }
    group.deployments.push(deployment);
    group.deploymentCount = group.deployments.length;

    urlMeta.set(row.url, { repo: row.repo_name, chart: row.chart_name, stars, key });
  }

  // Sort each group's deployments by stars desc for stable, useful ordering.
  for (const group of groups.values()) {
    group.deployments.sort((a, b) => b.stars - a.stars);
  }

  return { groups, urlMeta };
}

function maxStars(group: ReleaseGroup): number {
  let max = 0;
  for (const d of group.deployments) if (d.stars > max) max = d.stars;
  return max;
}

/** Search release groups by chart-name substring (case-insensitive). */
export function searchReleaseGroups(index: ReleaseIndex, query: string, limit: number, offset: number): { total: number; groups: ReleaseGroup[] } {
  const q = query.toLowerCase();
  const matches = [...index.groups.values()].filter((g) => g.chart.toLowerCase().includes(q));
  matches.sort((a, b) => b.deploymentCount - a.deploymentCount || maxStars(b) - maxStars(a) || a.chart.localeCompare(b.chart));
  return { total: matches.length, groups: matches.slice(offset, offset + limit) };
}
