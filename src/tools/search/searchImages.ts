import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataStore } from "../../data/db.js";
import { searchImages } from "../../domain/images.js";
import { imageSearchUrl } from "../../util/links.js";
import { ok, READ_ONLY, uniq } from "../helpers.js";

export function registerSearchImages(server: McpServer, store: DataStore): void {
  server.registerTool(
    "kubesearch_search_images",
    {
      title: "Search container images",
      description:
        "Search kubesearch.dev for container image repositories used across public home-ops clusters (substring match on " +
        "the image repository, case-insensitive). Returns each matching image repository, the tags seen in the wild, how " +
        "many deployments use it, and a few sample repos. Equivalent to the kubesearch.dev /image search.",
      inputSchema: {
        query: z.string().min(1).describe("Image repository substring, e.g. 'cert-manager', 'ghcr.io/home-operations', 'postgres'."),
        limit: z.number().int().min(1).max(100).default(25).describe("Max number of image repositories to return."),
      },
      outputSchema: {
        query: z.string(),
        total_matches: z.number(),
        shown: z.number(),
        image_url: z.string(),
        results: z.array(
          z.object({
            repository: z.string(),
            tags: z.array(z.string()),
            tag_count: z.number(),
            usage_count: z.number(),
            sample_repos: z.array(z.string()),
            repo_count: z.number().describe("Total distinct repos using this image; sample_repos shows up to 10."),
          }),
        ),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      await store.ready();
      const imageIndex = await store.getImageIndex();
      const releaseIndex = await store.getReleaseIndex();
      const { total, entries } = searchImages(imageIndex, query, limit);
      return ok({
        query,
        total_matches: total,
        shown: entries.length,
        image_url: imageSearchUrl(query),
        results: entries.map((e) => {
          const repos = uniq(e.fileUrls.map((u) => releaseIndex.urlMeta.get(u)?.repo).filter((r): r is string => !!r));
          return {
            repository: e.repository,
            tags: e.tags.slice(0, 25),
            tag_count: e.tags.length,
            usage_count: e.usageCount,
            sample_repos: repos.slice(0, 10),
            repo_count: repos.length,
          };
        }),
      });
    },
  );
}
