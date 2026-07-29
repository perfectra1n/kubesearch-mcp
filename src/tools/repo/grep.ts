import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoStore } from "../../repo/clone.js";
import { guarded, READ_ONLY } from "../helpers.js";

export function registerRepoGrep(server: McpServer, repos: RepoStore): void {
  server.registerTool(
    "repo_grep",
    {
      title: "Grep a cloned repository",
      description:
        "Search the text contents of a previously cloned repository (by `handle`) for a substring. Optionally restrict " +
        "to files matching a glob. Returns file paths, line numbers, and matching lines. If `truncated` is set, narrow " +
        "the search with a longer query or a `glob` rather than paging.",
      inputSchema: {
        handle: z.string().min(1).describe("The clone handle from repo_clone."),
        query: z.string().min(1).describe("Substring to search for across the repo's text files."),
        glob: z.string().optional().describe("Optional glob filter, e.g. '**/*.yaml'."),
        limit: z.number().int().min(1).max(500).default(100).describe("Max number of matching lines to return."),
        case_sensitive: z.boolean().default(false).describe("Match case-sensitively."),
      },
      outputSchema: {
        handle: z.string(),
        query: z.string(),
        total_matches: z.number(),
        matches: z.array(
          z.object({
            path: z.string(),
            line: z.number(),
            text: z.string(),
          }),
        ),
        truncated: z.boolean(),
      },
      annotations: READ_ONLY,
    },
    async ({ handle, query, glob, limit, case_sensitive }) =>
      guarded(async () => repos.grep(handle, query, glob, limit, case_sensitive) as unknown as Record<string, unknown>),
  );
}
