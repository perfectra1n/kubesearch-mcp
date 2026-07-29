import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoStore } from "../../repo/clone.js";
import { guarded, READ_ONLY } from "../helpers.js";

export function registerRepoReadFile(server: McpServer, repos: RepoStore): void {
  server.registerTool(
    "repo_read_file",
    {
      title: "Read a file from a cloned repository",
      description:
        "Read a text file from a previously cloned repository (by `handle` and relative `path`). Binary files are " +
        "refused and large files are truncated. Use the handle returned by `repo_clone`.",
      inputSchema: {
        handle: z.string().min(1).describe("The clone handle from repo_clone."),
        path: z
          .string()
          .min(1)
          .describe("Relative path to the file within the repo, e.g. 'kubernetes/apps/cert-manager/helmrelease.yaml'."),
        max_bytes: z
          .number()
          .int()
          .min(1)
          .max(4 * 1024 * 1024)
          .default(256 * 1024)
          .describe("Max bytes to return."),
      },
      outputSchema: {
        handle: z.string(),
        path: z.string(),
        content: z.string(),
        bytes: z.number(),
        truncated: z.boolean(),
      },
      annotations: READ_ONLY,
    },
    async ({ handle, path, max_bytes }) => guarded(async () => repos.read(handle, path, max_bytes) as unknown as Record<string, unknown>),
  );
}
