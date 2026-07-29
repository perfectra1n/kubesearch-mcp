import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { Database } from "better-sqlite3";
import { mergeHelmURL, releaseKey } from "./releaseKey.js";
import type { Deployment, ReleaseGroup, ReleaseIndex, SearchEntry } from "./types.js";

/** Rows processed between event-loop yields while building the index. */
const YIELD_EVERY = 2000;

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
    repo.stars, repo.url as repo_url,
    rel.chart_ref_kind as chart_ref_kind, null as source_tag
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
    repo.stars, repo.url as repo_url,
    rel.chart_ref_kind as chart_ref_kind, flor.tag as source_tag
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
    repo.stars, repo.url as repo_url,
    'Argo' as chart_ref_kind, null as source_tag
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
  chart_ref_kind: string | null;
  source_tag: string | null;
}

/**
 * Derive the real chart name from an OCIRepository `spec.url` when it differs
 * from the (possibly mislabeled) `chart_name`. For `chartRef` HelmReleases the
 * upstream indexer records `chart_name` as the HelmRelease/OCIRepository name
 * (e.g. "homepage"), while the OCI url's last path segment is the actual chart
 * (e.g. "oci://ghcr.io/bjw-s-labs/helm/app-template" -> "app-template").
 * Returns null when it can't add information (non-OCI, empty, or already equal).
 */
function deriveOciChart(rawUrl: string, chartName: string): string | null {
  const last = rawUrl.replace(/\/+$/, "").split("/").pop() ?? "";
  if (!last || last === chartName) return null;
  return last;
}

/**
 * Build the full release-key index from the metadata database.
 *
 * Streams the rows and yields to the event loop periodically: better-sqlite3 is
 * synchronous, so building this in one go would stall every other request
 * (including health checks) for the duration.
 */
export async function buildReleaseIndex(db: Database): Promise<ReleaseIndex> {
  const rows = db.prepare(COLLECTOR_QUERY).iterate() as Iterable<CollectorRow>;
  const groups = new Map<string, ReleaseGroup>();
  const urlMeta = new Map<string, import("./types.js").UrlMeta>();
  let processed = 0;

  for (const row of rows) {
    if (++processed % YIELD_EVERY === 0) await yieldToLoop();
    const rawUrl = row.helm_repo_url ?? "";
    const mergedUrl = mergeHelmURL(rawUrl);
    const key = releaseKey(mergedUrl, row.chart_name, row.release_name);
    const stars = row.stars ?? 0;
    const sourceKind = row.chart_ref_kind;
    const resolvedChart = sourceKind === "OCIRepository" ? deriveOciChart(rawUrl, row.chart_name) : null;

    const deployment: Deployment = {
      key,
      chart: row.chart_name,
      release: row.release_name,
      namespace: row.namespace,
      chartVersion: row.chart_version,
      chartSourceUrl: mergedUrl,
      sourceUrl: rawUrl,
      sourceKind,
      sourceTag: row.source_tag,
      resolvedChart,
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
      group = {
        id: key,
        chart: row.chart_name,
        chartSourceUrl: mergedUrl,
        sourceUrls: [],
        resolvedChart: null,
        chartSourceAmbiguous: false,
        deploymentCount: 0,
        deployments: [],
      };
      groups.set(key, group);
    }
    group.deployments.push(deployment);
    group.deploymentCount = group.deployments.length;

    urlMeta.set(row.url, { repo: row.repo_name, chart: row.chart_name, stars, key });
  }

  // Sort each group's deployments by stars desc, and derive the group-level raw
  // source summary (a single merged `chartSourceUrl` can collapse several distinct
  // real chart urls, so the raw data is most accurate per-deployment).
  for (const group of groups.values()) {
    group.deployments.sort((a, b) => b.stars - a.stars);
    const distinctUrls = [...new Set(group.deployments.map((d) => d.sourceUrl).filter(Boolean))];
    group.sourceUrls = distinctUrls.slice(0, 5);
    group.chartSourceAmbiguous = distinctUrls.length > 1;
    const distinctResolved = [...new Set(group.deployments.map((d) => d.resolvedChart).filter(Boolean))];
    group.resolvedChart = distinctResolved.length === 1 ? distinctResolved[0]! : null;
  }

  // Ranking doesn't depend on the query, so sort once here rather than on every
  // search. `deployments` is already stars-desc, so its head is the max.
  const searchList: Array<SearchEntry<ReleaseGroup>> = [...groups.values()].map((group) => ({
    lower: group.chart.toLowerCase(),
    item: group,
  }));
  searchList.sort(
    (a, b) =>
      b.item.deploymentCount - a.item.deploymentCount ||
      (b.item.deployments[0]?.stars ?? 0) - (a.item.deployments[0]?.stars ?? 0) ||
      a.item.chart.localeCompare(b.item.chart),
  );

  return { groups, urlMeta, searchList };
}

/** Search release groups by chart-name substring (case-insensitive). */
export function searchReleaseGroups(index: ReleaseIndex, query: string, limit: number, offset: number): { total: number; groups: ReleaseGroup[] } {
  const q = query.toLowerCase();
  const matches = index.searchList.filter((e) => e.lower.includes(q));
  return { total: matches.length, groups: matches.slice(offset, offset + limit).map((e) => e.item) };
}
