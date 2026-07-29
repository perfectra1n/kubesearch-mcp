import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataStore } from "../../data/db.js";
import { grepValues } from "../../domain/grep.js";
import { grepSearchUrl } from "../../util/links.js";
import { ok, READ_ONLY } from "../helpers.js";

export function registerGrepValues(server: McpServer, store: DataStore): void {
  server.registerTool(
    "kubesearch_grep_values",
    {
      title: "Grep HelmRelease values",
      description:
        "Full-text grep across the Helm `spec.values` of every indexed HelmRelease/Application (substring match). " +
        "Great for finding real-world examples of a config key or value, e.g. 'cert-manager.io', 'nodeSelector', " +
        "'gatus'. Returns the matched key path, a snippet, and the source file. Mirrors the kubesearch.dev /grep search.",
      inputSchema: {
        query: z.string().min(1).describe("Substring to grep for in values (keys or values), e.g. 'cert-manager.io'."),
        limit: z.number().int().min(1).max(200).default(30).describe("Max number of matching files to return."),
        offset: z.number().int().min(0).default(0).describe("Skip this many matches (results are ranked by repo stars)."),
        case_sensitive: z.boolean().default(false).describe("Match case-sensitively."),
      },
      outputSchema: {
        query: z.string(),
        total_files: z.number(),
        shown: z.number(),
        offset: z.number(),
        has_more: z.boolean(),
        grep_url: z.string(),
        results: z.array(
          z.object({
            repo: z.string().nullable(),
            chart: z.string().nullable(),
            stars: z.number().nullable(),
            matched_key: z.string().nullable(),
            snippet: z.string(),
            file_url: z.string(),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit, offset, case_sensitive }) => {
      await store.ready();
      const index = store.getReleaseIndex();
      const result = grepValues(store.database, index, query, limit, case_sensitive, offset);
      return ok({
        query,
        total_files: result.totalFiles,
        shown: result.matches.length,
        offset,
        has_more: offset + result.matches.length < result.totalFiles,
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
}
