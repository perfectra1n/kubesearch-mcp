import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataStore } from "../../data/db.js";
import type { Deployment } from "../../domain/types.js";
import { summarizeValues } from "../../domain/valuesSummary.js";
import { projectPaths } from "../../util/jsonWalk.js";
import { helmReleaseDetailUrl } from "../../util/links.js";
import { fail, ok, READ_ONLY } from "../helpers.js";

/** Soft budget (bytes of serialized JSON) for the `values` drill-down view. */
const VALUES_VIEW_BUDGET = 24_000;

function slimRepo(d: Deployment) {
  return {
    repo: d.repo,
    repo_url: d.repoUrl,
    stars: d.stars,
    release_name: d.release,
    namespace: d.namespace,
    chart_version: d.chartVersion,
    file_url: d.fileUrl,
    timestamp: d.timestamp,
    source_url: d.sourceUrl,
    source_kind: d.sourceKind,
    source_tag: d.sourceTag,
    resolved_chart: d.resolvedChart,
  };
}

export function registerGetRelease(server: McpServer, store: DataStore): void {
  server.registerTool(
    "kubesearch_get_release",
    {
      title: "Get HelmRelease details",
      description:
        "Get details for one chart by its kubesearch.dev release id (the `id` from `kubesearch_search_releases`, e.g. " +
        "'ghcr.io-home-operations-charts-mirror-cert-manager'). Three views, controlled by `view`:\n" +
        "- `summary` (default): a compact digest of how the community configures the chart — the most commonly-set " +
        "`spec.values` paths with their typical values, plus a couple of full example configs. Start here.\n" +
        "- `deployments`: the paginated list of every repo deploying the chart (no values) — use it to find a repo to " +
        "drill into.\n" +
        "- `values`: the full parsed `spec.values` for selected deployments — narrow with `repo` and/or `value_paths` to " +
        "fetch just the config (or subtree) you care about. This is the drill-down; prefer `summary` first.\n" +
        "Note: `chart_source_url` is the normalized kubesearch.dev grouping key, not necessarily the pullable chart. For " +
        "`chartRef`/OCIRepository releases the real chart is in `source_urls` (group) and each deployment's `source_url` + " +
        "`source_tag`; `resolved_chart` surfaces the true chart name when it differs from `chart`. Confirm by cloning the " +
        "deployment's repo (repo_clone) and reading its OCIRepository source.yaml.",
      inputSchema: {
        id: z.string().min(1).describe("The release id / slug, e.g. 'ghcr.io-home-operations-charts-mirror-cert-manager'."),
        view: z
          .enum(["summary", "deployments", "values"])
          .default("summary")
          .describe("summary = community config digest (default); deployments = paginated repo list; values = full config drill-down."),
        limit: z.number().int().min(1).max(100).default(10).describe("Page size for `deployments`/`values` views."),
        offset: z.number().int().min(0).default(0).describe("Pagination offset for `deployments`/`values` views."),
        top: z.number().int().min(1).max(100).default(25).describe("`summary` view: number of common value paths to return."),
        examples: z.number().int().min(0).max(5).default(2).describe("`summary` view: number of full example configs to include."),
        repo: z.string().optional().describe("`values` view: restrict to one repo (e.g. 'onedr0p/home-ops')."),
        value_paths: z
          .array(z.string().min(1))
          .optional()
          .describe("`values` view: only return these value-path subtrees, e.g. ['server.persistentVolume','server.retentionPeriod']."),
      },
      outputSchema: {
        id: z.string(),
        chart: z.string(),
        chart_source_url: z.string(),
        source_urls: z.array(z.string()),
        resolved_chart: z.string().nullable(),
        chart_source_ambiguous: z.boolean(),
        deployment_count: z.number(),
        kubesearch_url: z.string(),
        view: z.enum(["summary", "deployments", "values"]),
        // summary view
        values_summary: z
          .object({
            analyzed_deployments: z.number(),
            common_settings: z.array(
              z.object({
                path: z.string(),
                set_by: z.number(),
                set_pct: z.number(),
                values: z.array(z.object({ value: z.string(), count: z.number() })),
                distinct_values: z.number(),
              }),
            ),
            examples: z.array(
              z.object({
                repo: z.string(),
                stars: z.number(),
                chart_version: z.string().nullable(),
                file_url: z.string(),
                values: z.unknown(),
              }),
            ),
          })
          .optional(),
        top_repos: z
          .array(
            z.object({
              repo: z.string(),
              repo_url: z.string().nullable(),
              stars: z.number(),
              release_name: z.string(),
              namespace: z.string().nullable(),
              chart_version: z.string().nullable(),
              file_url: z.string(),
              timestamp: z.string(),
              source_url: z.string(),
              source_kind: z.string().nullable(),
              source_tag: z.string().nullable(),
              resolved_chart: z.string().nullable(),
            }),
          )
          .optional(),
        // deployments / values views
        shown: z.number().optional(),
        offset: z.number().optional(),
        has_more: z.boolean().optional(),
        deployments: z
          .array(
            z.object({
              repo: z.string(),
              repo_url: z.string().nullable(),
              stars: z.number(),
              release_name: z.string(),
              namespace: z.string().nullable(),
              chart_version: z.string().nullable(),
              file_url: z.string(),
              timestamp: z.string(),
              source_url: z.string(),
              source_kind: z.string().nullable(),
              source_tag: z.string().nullable(),
              resolved_chart: z.string().nullable(),
              values: z.unknown().optional(),
              values_omitted: z.string().optional(),
            }),
          )
          .optional(),
        next_step: z.string().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ id, view, limit, offset, top, examples, repo, value_paths }) => {
      await store.ready();
      const index = store.getReleaseIndex();
      const group = index.groups.get(id);
      if (!group) {
        return fail(
          `No HelmRelease found with id "${id}". Use kubesearch_search_releases to find a valid id (the "id" field of each result).`,
        );
      }

      const base = {
        id: group.id,
        chart: group.chart,
        chart_source_url: group.chartSourceUrl,
        source_urls: group.sourceUrls,
        resolved_chart: group.resolvedChart,
        chart_source_ambiguous: group.chartSourceAmbiguous,
        deployment_count: group.deploymentCount,
        kubesearch_url: helmReleaseDetailUrl(group.id),
        view,
      };

      if (view === "summary") {
        const candidates = group.deployments.slice(0, 50);
        const valuesByUrl = store.getValues(candidates.map((d) => d.fileUrl));
        const summary = summarizeValues(group.deployments, valuesByUrl, { top, examples });
        return ok({
          ...base,
          values_summary: {
            analyzed_deployments: summary.analyzedDeployments,
            common_settings: summary.commonSettings.map((c) => ({
              path: c.path,
              set_by: c.setBy,
              set_pct: c.setPct,
              values: c.values,
              distinct_values: c.distinctValues,
            })),
            examples: summary.examples.map((e) => ({
              repo: e.repo,
              stars: e.stars,
              chart_version: e.chartVersion,
              file_url: e.fileUrl,
              values: e.values,
            })),
          },
          top_repos: group.deployments.slice(0, 10).map(slimRepo),
          next_step:
            `Use view:"deployments" to page through all ${group.deploymentCount} repos, or view:"values" ` +
            `(with repo and/or value_paths) to see a specific deployment's full config.`,
        });
      }

      if (view === "deployments") {
        const page = group.deployments.slice(offset, offset + limit);
        return ok({
          ...base,
          shown: page.length,
          offset,
          has_more: offset + page.length < group.deploymentCount,
          deployments: page.map(slimRepo),
          next_step: 'Use view:"values" with a repo or file_url from this list to fetch its full spec.values.',
        });
      }

      // view === "values": full (optionally projected) config for selected deployments.
      let selected = group.deployments;
      if (repo) {
        const needle = repo.toLowerCase();
        selected = selected.filter((d) => d.repo.toLowerCase() === needle || d.repo.toLowerCase().includes(needle));
        if (selected.length === 0) {
          return fail(
            `No deployment from a repo matching "${repo}" in release "${id}". Use view:"deployments" to list the repos.`,
          );
        }
      }
      const page = selected.slice(offset, offset + limit);
      const valuesByUrl = store.getValues(page.map((d) => d.fileUrl));

      let budget = VALUES_VIEW_BUDGET;
      let budgetHit = false;
      const deployments = page.map((d) => {
        const raw = valuesByUrl.get(d.fileUrl) ?? null;
        const values = value_paths && value_paths.length > 0 ? projectPaths(raw, value_paths) : raw;
        if (budgetHit) {
          return { ...slimRepo(d), values_omitted: 'response budget reached — narrow with value_paths or a higher offset' };
        }
        const size = JSON.stringify(values ?? null).length;
        budget -= size;
        if (budget < 0) {
          budgetHit = true;
          return { ...slimRepo(d), values_omitted: 'response budget reached — narrow with value_paths or a higher offset' };
        }
        return { ...slimRepo(d), values };
      });

      return ok({
        ...base,
        shown: page.length,
        offset,
        has_more: budgetHit || offset + page.length < selected.length,
        deployments,
        ...(value_paths && value_paths.length > 0 ? {} : { next_step: "Pass value_paths to fetch only the config subtrees you need." }),
      });
    },
  );
}
