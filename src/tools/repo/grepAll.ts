import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoStore } from "../../repo/clone.js";
import type { RepoPool } from "../../repo/pool.js";
import { guarded, READ_ONLY } from "../helpers.js";

export function registerRepoGrepAll(server: McpServer, repos: RepoStore, pool: RepoPool): void {
  server.registerTool(
    "repo_grep_all",
    {
      title: "Grep the always-warm pool of top repos",
      description:
        "Substring-search the actual files of the most popular indexed home-ops repositories at once — no clone step " +
        "needed. The server keeps these repos permanently cloned, so this covers every resource kind (Kustomizations, " +
        "Ingress/HTTPRoute, ExternalSecrets, Talos configs, …), not just Helm values like `kubesearch_grep_values`. " +
        "Hits are grouped by repo, most-starred first, and each group carries a `handle` you can pass straight to " +
        "`repo_read_file` / `repo_list_files` / `repo_grep` for the follow-up. `pool` reports which repos were " +
        "searchable: while `pool.syncing` is true and `ready` is below `size` the pool is still warming up, so an empty " +
        "result is not final — retry after a short pause.",
      inputSchema: {
        query: z.string().min(1).describe("Substring to search for, e.g. 'gatus.io/enabled' or 'kind: HTTPRoute'."),
        glob: z.string().optional().describe("Optional path glob, e.g. '**/*.yaml' or 'kubernetes/apps/**'."),
        case_sensitive: z.boolean().default(false).describe("Match case-sensitively."),
        max_per_repo: z.number().int().min(1).max(100).default(20).describe("Max matching lines returned per repo."),
        limit: z.number().int().min(1).max(500).default(200).describe("Max matching lines returned overall."),
      },
      outputSchema: {
        query: z.string(),
        pool: z.object({
          size: z.number(),
          ready: z.number(),
          syncing: z.boolean(),
          pending: z.array(z.string()),
          failed: z.array(z.object({ repo: z.string(), error: z.string() })),
        }),
        repos_searched: z.number(),
        total_matches: z.number(),
        truncated: z.boolean(),
        repos: z.array(
          z.object({
            handle: z.string(),
            repo: z.string(),
            stars: z.number(),
            branch: z.string(),
            match_count: z.number(),
            truncated: z.boolean(),
            matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ query, glob, case_sensitive, max_per_repo, limit }) =>
      guarded(async () => {
        const result = await repos.grepAll(query, { glob, caseSensitive: case_sensitive, maxPerRepo: max_per_repo, limit });
        const status = pool.status();
        return {
          query: result.query,
          pool: {
            size: status.size,
            ready: status.ready,
            syncing: status.syncing,
            pending: status.members.filter((m) => m.state === "pending").map((m) => m.repo),
            failed: status.members.filter((m) => m.state === "failed").map((m) => ({ repo: m.repo, error: m.error ?? "unknown error" })),
          },
          repos_searched: result.repos_searched,
          total_matches: result.total_matches,
          truncated: result.truncated,
          repos: result.repos,
        };
      }),
  );
}
