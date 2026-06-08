import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataStore } from "../data/db.js";
import { searchReleaseGroups } from "../domain/helmReleases.js";
import { searchImages } from "../domain/images.js";
import { grepValues } from "../domain/grep.js";
import { grepSearchUrl, helmReleaseDetailUrl, helmReleaseSearchUrl, imageSearchUrl } from "../util/links.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function json(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}

export function registerAllTools(server: McpServer, store: DataStore): void {
  server.registerTool(
    "search_helm_releases",
    {
      title: "Search HelmReleases",
      description:
        "Search kubesearch.dev for Flux HelmReleases / Argo Applications by chart name (substring, case-insensitive). " +
        "Mirrors the kubesearch.dev homepage search (e.g. 'cert-manager'). Results are grouped by chart source and " +
        "ranked by how many public home-ops repos deploy them. Each result includes an `id` you can pass to " +
        "`get_helm_release` for full details, plus a kubesearch.dev link.",
      inputSchema: {
        query: z.string().min(1).describe("Chart name or substring to search for, e.g. 'cert-manager', 'authentik', 'plex'."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max number of chart groups to return."),
        offset: z.number().int().min(0).default(0).describe("Pagination offset into the ranked results."),
      },
    },
    async ({ query, limit, offset }) => {
      await store.ready();
      const index = store.getReleaseIndex();
      const { total, groups } = searchReleaseGroups(index, query, limit, offset);
      return json({
        query,
        total_matches: total,
        shown: groups.length,
        search_url: helmReleaseSearchUrl(query),
        results: groups.map((g) => ({
          id: g.id,
          chart: g.chart,
          chart_source_url: g.chartSourceUrl,
          deployment_count: g.deploymentCount,
          kubesearch_url: helmReleaseDetailUrl(g.id),
          top_repos: g.deployments.slice(0, 10).map((d) => ({
            repo: d.repo,
            stars: d.stars,
            chart_version: d.chartVersion,
            namespace: d.namespace,
            file_url: d.fileUrl,
          })),
        })),
      });
    },
  );

  server.registerTool(
    "get_helm_release",
    {
      title: "Get HelmRelease details",
      description:
        "Get full details for one chart by its kubesearch.dev release id (the `id` returned by `search_helm_releases`, " +
        "e.g. 'ghcr.io-home-operations-charts-mirror-cert-manager'). Lists every public repo deploying it. " +
        "Set `include_values: true` to also return each deployment's parsed Helm `spec.values` (useful for seeing how " +
        "people configure the chart). Equivalent to the kubesearch.dev /hr/<id> page.",
      inputSchema: {
        id: z.string().min(1).describe("The release id / slug, e.g. 'ghcr.io-home-operations-charts-mirror-cert-manager'."),
        include_values: z.boolean().default(false).describe("Include parsed spec.values for each deployment (can be large)."),
      },
    },
    async ({ id, include_values }) => {
      await store.ready();
      const index = store.getReleaseIndex();
      const group = index.groups.get(id);
      if (!group) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `No HelmRelease found with id "${id}". Use search_helm_releases to find a valid id (the "id" field of each result).`,
            },
          ],
        };
      }

      const VALUES_CAP = 30;
      let valuesByUrl: Map<string, unknown> | null = null;
      if (include_values) {
        const urls = group.deployments.slice(0, VALUES_CAP).map((d) => d.fileUrl);
        valuesByUrl = store.getValues(urls);
      }

      return json({
        id: group.id,
        chart: group.chart,
        chart_source_url: group.chartSourceUrl,
        deployment_count: group.deploymentCount,
        kubesearch_url: helmReleaseDetailUrl(group.id),
        values_truncated: include_values && group.deploymentCount > VALUES_CAP ? `values shown for first ${VALUES_CAP} deployments` : undefined,
        deployments: group.deployments.map((d) => ({
          repo: d.repo,
          repo_url: d.repoUrl,
          stars: d.stars,
          release_name: d.release,
          namespace: d.namespace,
          chart_version: d.chartVersion,
          file_url: d.fileUrl,
          timestamp: d.timestamp,
          icon: d.icon,
          group: d.group,
          ...(valuesByUrl ? { values: valuesByUrl.get(d.fileUrl) ?? null } : {}),
        })),
      });
    },
  );

  server.registerTool(
    "search_images",
    {
      title: "Search container images",
      description:
        "Search kubesearch.dev for container image repositories used across public home-ops clusters (substring match on " +
        "the image repository, case-insensitive). Returns each matching image repository, the tags seen in the wild, how " +
        "many deployments use it, and a few sample repos. Equivalent to the kubesearch.dev /image search.",
      inputSchema: {
        query: z.string().min(1).describe("Image repository substring, e.g. 'cert-manager', 'ghcr.io/home-operations', 'postgres'."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max number of image repositories to return."),
      },
    },
    async ({ query, limit }) => {
      await store.ready();
      const imageIndex = store.getImageIndex();
      const releaseIndex = store.getReleaseIndex();
      const { total, entries } = searchImages(imageIndex, query, limit);
      return json({
        query,
        total_matches: total,
        shown: entries.length,
        image_url: imageSearchUrl(query),
        results: entries.map((e) => ({
          repository: e.repository,
          tags: e.tags.slice(0, 25),
          tag_count: e.tags.length,
          usage_count: e.usageCount,
          sample_repos: uniq(e.fileUrls.map((u) => releaseIndex.urlMeta.get(u)?.repo).filter((r): r is string => !!r)).slice(0, 10),
        })),
      });
    },
  );

  server.registerTool(
    "grep_values",
    {
      title: "Grep HelmRelease values",
      description:
        "Full-text grep across the Helm `spec.values` of every indexed HelmRelease/Application (substring match). " +
        "Great for finding real-world examples of a config key or value, e.g. 'cert-manager.io', 'nodeSelector', " +
        "'ingressClassName: traefik'. Returns the matched key path, a snippet, and the source file. Mirrors the " +
        "kubesearch.dev /grep search.",
      inputSchema: {
        query: z.string().min(1).describe("Substring to grep for in values (keys or values), e.g. 'cert-manager.io'."),
        limit: z.number().int().min(1).max(200).default(30).describe("Max number of matching files to return."),
        case_sensitive: z.boolean().default(false).describe("Match case-sensitively."),
      },
    },
    async ({ query, limit, case_sensitive }) => {
      await store.ready();
      const index = store.getReleaseIndex();
      const result = grepValues(store.database, index, query, limit, case_sensitive);
      return json({
        query,
        total_files: result.totalFiles,
        shown: result.matches.length,
        grep_url: grepSearchUrl(query),
        results: result.matches.map((m) => ({
          repo: m.repo,
          chart: m.chart,
          stars: m.stars,
          matched_key: m.matchedKey,
          snippet: m.snippet,
          file_url: m.fileUrl,
        })),
      });
    },
  );

  server.registerTool(
    "kubesearch_status",
    {
      title: "Kubesearch data status",
      description:
        "Report the freshness and size of the locally cached kubesearch.dev data: the release tag (date), when it was " +
        "loaded, the cache directory, and row counts. Useful to confirm how current the search data is.",
      inputSchema: {},
    },
    async () => {
      await store.ready();
      return json(store.status());
    },
  );
}
