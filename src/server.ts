import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRepoTools, registerSearchTools } from "./tools/index.js";
import { registerPrompts } from "./prompts/index.js";
import type { DataStore } from "./data/db.js";
import type { RepoStore } from "./repo/clone.js";
import { log } from "./util/log.js";

/**
 * Wrap server.registerTool so every tool registered downstream logs its
 * invocation, duration, and outcome — one chokepoint instead of touching all
 * the individual tool files.
 */
function instrumentToolLogging(server: McpServer): void {
  const original = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: never, handler: (...args: never[]) => unknown) => {
    const wrapped = async (...args: never[]): Promise<unknown> => {
      const start = performance.now(); // monotonic — immune to wall-clock skew
      log.debug(`tool ${name} called`);
      try {
        const result = (await handler(...args)) as { isError?: boolean } | undefined;
        const outcome = result?.isError ? "error" : "ok";
        log.info(`tool ${name} ${outcome} (${Math.round(performance.now() - start)}ms)`);
        return result;
      } catch (err) {
        log.error(`tool ${name} threw after ${Math.round(performance.now() - start)}ms: ${(err as Error).message}`);
        throw err;
      }
    };
    return original(name, config, wrapped as never);
  }) as typeof server.registerTool;
}

function instructions(cloneEnabled: boolean): string {
  return (
    `kubesearch-mcp exposes kubesearch.dev — a search engine over Flux HelmReleases and Argo Applications across ` +
    `hundreds of public "home-ops" Kubernetes Git repositories.\n\n` +
    `Use it to discover how the community deploys software on Kubernetes:\n` +
    `- kubesearch_search_releases: find charts by name and see who deploys them.\n` +
    `- kubesearch_get_release: drill into one chart for every deployment and its values.\n` +
    `- kubesearch_search_images: find container image repositories and the tags used in the wild.\n` +
    `- kubesearch_grep_values: full-text grep across real-world Helm values for config examples.\n` +
    `- kubesearch_status: check how fresh the cached data is.\n` +
    (cloneEnabled
      ? `- repo_clone / repo_list_files / repo_read_file / repo_grep / repo_cleanup: temporarily clone a repo to review its actual manifests.\n`
      : "") +
    `\nThe prompts (e.g. kubesearch_compare_deployments) chain these tools into useful workflows.`
  );
}

export function buildServer(store: DataStore, repos: RepoStore): McpServer {
  const cloneEnabled = repos.enabled;
  const server = new McpServer(
    { name: "kubesearch-mcp", version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} }, instructions: instructions(cloneEnabled) },
  );
  instrumentToolLogging(server);
  registerSearchTools(server, store);
  if (cloneEnabled) registerRepoTools(server, repos);
  registerPrompts(server, { cloneEnabled });
  return server;
}
