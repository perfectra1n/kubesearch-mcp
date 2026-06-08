import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DataStore } from "../data/db.js";
import type { RepoStore } from "../repo/clone.js";
import { registerSearchReleases } from "./search/searchReleases.js";
import { registerGetRelease } from "./search/getRelease.js";
import { registerSearchImages } from "./search/searchImages.js";
import { registerGrepValues } from "./search/grepValues.js";
import { registerStatus } from "./search/status.js";
import { registerRepoClone } from "./repo/clone.js";
import { registerRepoListFiles } from "./repo/listFiles.js";
import { registerRepoReadFile } from "./repo/readFile.js";
import { registerRepoGrep } from "./repo/grep.js";
import { registerRepoCleanup } from "./repo/cleanup.js";

/** Register the kubesearch.dev search tools (always available). */
export function registerSearchTools(server: McpServer, store: DataStore): void {
  registerSearchReleases(server, store);
  registerGetRelease(server, store);
  registerSearchImages(server, store);
  registerGrepValues(server, store);
  registerStatus(server, store);
}

/** Register the temporary repository clone/review tools (gated by config). */
export function registerRepoTools(server: McpServer, repos: RepoStore): void {
  registerRepoClone(server, repos);
  registerRepoListFiles(server, repos);
  registerRepoReadFile(server, repos);
  registerRepoGrep(server, repos);
  registerRepoCleanup(server, repos);
}
