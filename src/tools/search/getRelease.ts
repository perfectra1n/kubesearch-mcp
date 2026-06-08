import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataStore } from "../../data/db.js";
import { helmReleaseDetailUrl } from "../../util/links.js";
import { fail, ok, READ_ONLY } from "../helpers.js";

const VALUES_CAP = 30;

export function registerGetRelease(server: McpServer, store: DataStore): void {
  server.registerTool(
    "kubesearch_get_release",
    {
      title: "Get HelmRelease details",
      description:
        "Get full details for one chart by its kubesearch.dev release id (the `id` returned by " +
        "`kubesearch_search_releases`, e.g. 'ghcr.io-home-operations-charts-mirror-cert-manager'). Lists every public " +
        "repo deploying it. Set `include_values: true` to also return each deployment's parsed Helm `spec.values` " +
        "(useful for seeing how people configure the chart). Equivalent to the kubesearch.dev /hr/<id> page.",
      inputSchema: {
        id: z.string().min(1).describe("The release id / slug, e.g. 'ghcr.io-home-operations-charts-mirror-cert-manager'."),
        include_values: z.boolean().default(false).describe("Include parsed spec.values for each deployment (can be large)."),
      },
      outputSchema: {
        id: z.string(),
        chart: z.string(),
        chart_source_url: z.string(),
        deployment_count: z.number(),
        kubesearch_url: z.string(),
        values_truncated: z.string().optional(),
        deployments: z.array(
          z.object({
            repo: z.string(),
            repo_url: z.string().nullable(),
            stars: z.number(),
            release_name: z.string(),
            namespace: z.string().nullable(),
            chart_version: z.string().nullable(),
            file_url: z.string(),
            timestamp: z.string(),
            icon: z.string().nullable(),
            group: z.string().nullable(),
            values: z.unknown().optional(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ id, include_values }) => {
      await store.ready();
      const index = store.getReleaseIndex();
      const group = index.groups.get(id);
      if (!group) {
        return fail(
          `No HelmRelease found with id "${id}". Use kubesearch_search_releases to find a valid id (the "id" field of each result).`,
        );
      }

      let valuesByUrl: Map<string, unknown> | null = null;
      if (include_values) {
        valuesByUrl = store.getValues(group.deployments.slice(0, VALUES_CAP).map((d) => d.fileUrl));
      }

      return ok({
        id: group.id,
        chart: group.chart,
        chart_source_url: group.chartSourceUrl,
        deployment_count: group.deploymentCount,
        kubesearch_url: helmReleaseDetailUrl(group.id),
        ...(include_values && group.deploymentCount > VALUES_CAP
          ? { values_truncated: `values shown for first ${VALUES_CAP} deployments` }
          : {}),
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
}
