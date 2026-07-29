import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoStore } from "../../repo/clone.js";
import { guarded } from "../helpers.js";

export function registerRepoCleanup(server: McpServer, repos: RepoStore): void {
  server.registerTool(
    "repo_cleanup",
    {
      title: "Delete a cloned repository",
      description:
        "Delete a temporary clone created by `repo_clone` (frees disk before its TTL). Clones are also auto-deleted " +
        "after inactivity, so this is optional but polite.",
      inputSchema: {
        handle: z.string().min(1).describe("The clone handle from repo_clone."),
      },
      outputSchema: {
        handle: z.string(),
        removed: z.boolean(),
      },
      annotations: { readOnlyHint: false, openWorldHint: false, idempotentHint: true, destructiveHint: false },
    },
    async ({ handle }) => guarded(async () => ({ handle, removed: await repos.cleanup(handle) })),
  );
}
