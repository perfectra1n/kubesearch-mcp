import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoStore } from "../../repo/clone.js";
import { guarded, READ_ONLY } from "../helpers.js";

export function registerRepoListFiles(server: McpServer, repos: RepoStore): void {
  server.registerTool(
    "repo_list_files",
    {
      title: "List files in a cloned repository",
      description:
        "List files in a previously cloned repository (by `handle`). Optionally scope to a sub-path and/or filter with a " +
        "glob (e.g. '**/*.yaml', 'kubernetes/**'). Use the handle returned by `repo_clone`.",
      inputSchema: {
        handle: z.string().min(1).describe("The clone handle from repo_clone."),
        path: z.string().default(".").describe("Sub-path within the repo to list (default: repo root)."),
        glob: z.string().optional().describe("Optional glob filter applied to file paths, e.g. '**/*.yaml'."),
      },
      outputSchema: {
        handle: z.string(),
        path: z.string(),
        entries: z.array(
          z.object({
            path: z.string(),
            type: z.enum(["file", "dir"]),
            size: z.number().optional(),
          }),
        ),
        truncated: z.boolean(),
      },
      annotations: READ_ONLY,
    },
    async ({ handle, path, glob }) => guarded(async () => repos.list(handle, path, glob) as unknown as Record<string, unknown>),
  );
}
