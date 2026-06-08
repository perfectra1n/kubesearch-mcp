import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataStore } from "../../data/db.js";
import { ok, READ_ONLY } from "../helpers.js";

export function registerStatus(server: McpServer, store: DataStore): void {
  server.registerTool(
    "kubesearch_status",
    {
      title: "Kubesearch data status",
      description:
        "Report the freshness and size of the locally cached kubesearch.dev data: the release tag (date), when it was " +
        "loaded, the cache directory, and row counts. Useful to confirm how current the search data is.",
      inputSchema: {},
      outputSchema: {
        tag: z.string(),
        cacheDir: z.string(),
        loadedAt: z.string(),
        releaseFiles: z.number(),
        reposIndexed: z.number(),
        helmReleases: z.number(),
        ociRepositories: z.number(),
        valueDocuments: z.number(),
      },
      annotations: READ_ONLY,
    },
    async () => {
      await store.ready();
      return ok(store.status() as unknown as Record<string, unknown>);
    },
  );
}
