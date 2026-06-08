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
        "Search the text contents of a previously cloned repository (by `handle`) for a substring (case-insensitive). " +
        "Optionally restrict to files matching a glob. Returns file paths, line numbers, and matching lines.",
      inputSchema: {
        handle: z.string().min(1).describe("The clone handle from repo_clone."),
        query: z.string().min(1).describe("Substring to search for across the repo's text files."),
        glob: z.string().optional().describe("Optional glob filter, e.g. '**/*.yaml'."),
        max_results: z.number().int().min(1).max(500).default(100).describe("Max number of matching lines to return."),
      },
      annotations: READ_ONLY,
    },
    async ({ handle, query, glob, max_results }) =>
      guarded(async () => repos.grep(handle, query, glob, max_results) as unknown as Record<string, unknown>),
  );
}
