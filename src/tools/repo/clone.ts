import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoStore } from "../../repo/clone.js";
import { guarded } from "../helpers.js";

export function registerRepoClone(server: McpServer, repos: RepoStore): void {
  server.registerTool(
    "repo_clone",
    {
      title: "Clone a repository (temporary)",
      description:
        "Temporarily clone a public Git repository so you can review its actual files. Accepts an indexed home-ops repo " +
        "name (e.g. 'onedr0p/home-ops' — resolved to its real clone URL and branch) or a full https Git URL. The clone " +
        "is shallow, sandboxed, size/time-limited, and auto-deleted after a TTL. Returns a `handle` to use with " +
        "`repo_list_files`, `repo_read_file`, and `repo_grep`, plus a curated file tree to get you started. " +
        "Call `repo_cleanup` when done.",
      inputSchema: {
        repo: z.string().min(1).describe("An indexed repo name like 'onedr0p/home-ops', or a full https:// Git URL."),
      },
      outputSchema: {
        handle: z.string(),
        resolved_url: z.string(),
        branch: z.string(),
        file_count: z.number(),
        size_mb: z.number(),
        expires_in_minutes: z.number(),
        reused: z.boolean(),
        updated: z.boolean(),
        tree: z.array(z.string()),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false, destructiveHint: false },
    },
    async ({ repo }) => guarded(async () => repos.clone(repo) as unknown as Record<string, unknown>),
  );
}
