import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools } from "./tools/index.js";
import type { DataStore } from "./data/db.js";

const INSTRUCTIONS = `kubesearch-mcp exposes kubesearch.dev — a search engine over Flux HelmReleases and
Argo Applications across hundreds of public "home-ops" Kubernetes Git repositories.

Use it to discover how the community deploys software on Kubernetes:
- search_helm_releases: find charts by name and see who deploys them.
- get_helm_release: drill into one chart for every deployment and its values.
- search_images: find container image repositories and the tags used in the wild.
- grep_values: full-text grep across real-world Helm values for config examples.
- kubesearch_status: check how fresh the cached data is.`;

export function buildServer(store: DataStore): McpServer {
  const server = new McpServer(
    { name: "kubesearch-mcp", version: "0.1.0" },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );
  registerAllTools(server, store);
  return server;
}
