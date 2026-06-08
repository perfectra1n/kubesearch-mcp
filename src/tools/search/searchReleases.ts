import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataStore } from "../../data/db.js";
import { searchReleaseGroups } from "../../domain/helmReleases.js";
import { helmReleaseDetailUrl, helmReleaseSearchUrl } from "../../util/links.js";
import { ok, READ_ONLY } from "../helpers.js";

export function registerSearchReleases(server: McpServer, store: DataStore): void {
  server.registerTool(
    "kubesearch_search_releases",
    {
      title: "Search HelmReleases",
      description:
        "Search kubesearch.dev for Flux HelmReleases / Argo Applications by chart name (substring, case-insensitive). " +
        "Mirrors the kubesearch.dev homepage search (e.g. 'cert-manager'). Results are grouped by chart source and " +
        "ranked by how many public home-ops repos deploy them. Each result includes an `id` you can pass to " +
        "`kubesearch_get_release` for full details, plus a kubesearch.dev link.",
      inputSchema: {
        query: z.string().min(1).describe("Chart name or substring to search for, e.g. 'cert-manager', 'authentik', 'plex'."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max number of chart groups to return."),
        offset: z.number().int().min(0).default(0).describe("Pagination offset into the ranked results."),
      },
      outputSchema: {
        query: z.string(),
        total_matches: z.number(),
        shown: z.number(),
        search_url: z.string(),
        results: z.array(
          z.object({
            id: z.string(),
            chart: z.string(),
            chart_source_url: z.string(),
            deployment_count: z.number(),
            kubesearch_url: z.string(),
            top_repos: z.array(
              z.object({
                repo: z.string(),
                stars: z.number(),
                chart_version: z.string().nullable(),
                namespace: z.string().nullable(),
                file_url: z.string(),
              }),
            ),
            more_repos: z.number().describe("Deployments beyond the shown top_repos — fetch them with kubesearch_get_release."),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit, offset }) => {
      await store.ready();
      const index = store.getReleaseIndex();
      const { total, groups } = searchReleaseGroups(index, query, limit, offset);
      return ok({
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
          more_repos: Math.max(0, g.deploymentCount - 10),
        })),
      });
    },
  );
}
