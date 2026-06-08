import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type GetPromptResult = {
  description?: string;
  messages: Array<{ role: "user"; content: { type: "text"; text: string } }>;
};

function userPrompt(text: string, description?: string): GetPromptResult {
  return { description, messages: [{ role: "user", content: { type: "text", text } }] };
}

/**
 * Server-provided prompt templates — reusable workflow shortcuts that chain the
 * search (and, when enabled, repo) tools toward a useful outcome.
 */
export function registerPrompts(server: McpServer, opts: { cloneEnabled: boolean }): void {
  server.registerPrompt(
    "kubesearch_compare_deployments",
    {
      title: "Compare how repos deploy a chart",
      description: "Compare how the most popular home-ops repos configure a given Helm chart.",
      argsSchema: { chart: z.string().min(1).describe("Chart name, e.g. 'cert-manager' or 'authentik'.") },
    },
    ({ chart }) =>
      userPrompt(
        `Compare how popular home-ops repositories deploy the "${chart}" Helm chart.\n\n` +
          `1. Call kubesearch_search_releases with query "${chart}" and note the top result ids (most-deployed first).\n` +
          `2. For the top 2-3 ids, call kubesearch_get_release with include_values: true.\n` +
          `3. Summarize how their spec.values differ (versions, key settings, resource limits, ingress, persistence) ` +
          `and call out notable or unusual configuration choices.\n` +
          `4. Recommend a sensible baseline configuration, citing the source repos and their kubesearch.dev links.`,
        `Compare deployments of ${chart}`,
      ),
  );

  server.registerPrompt(
    "kubesearch_adopt_chart",
    {
      title: "Adopt a chart the community way",
      description: "Produce a recommended, community-aligned way to deploy a chart.",
      argsSchema: { chart: z.string().min(1).describe("Chart name to adopt, e.g. 'authentik'.") },
    },
    ({ chart }) =>
      userPrompt(
        `I want to deploy "${chart}" on my Flux-managed Kubernetes cluster the way the community does.\n\n` +
          `1. Use kubesearch_search_releases for "${chart}" to find the most common chart source (OCI/HelmRepository) ` +
          `and the most-used release id.\n` +
          `2. Use kubesearch_get_release (include_values: true) on the top id to see real configurations.\n` +
          `3. Draft a clean HelmRelease (and HelmRepository/OCIRepository if needed) with sensible values, ` +
          `explaining each non-default choice and linking the source repos you based it on.`,
        `Adopt ${chart}`,
      ),
  );

  server.registerPrompt(
    "kubesearch_find_config_examples",
    {
      title: "Find real-world config examples",
      description: "Find real-world examples of a config key or value across home-ops clusters.",
      argsSchema: { query: z.string().min(1).describe("Config key/value substring, e.g. 'cert-manager.io/cluster-issuer'.") },
    },
    ({ query }) =>
      userPrompt(
        `Find real-world examples of "${query}" in Helm values across home-ops clusters.\n\n` +
          `1. Call kubesearch_grep_values with query "${query}".\n` +
          `2. Group the matches by what they're doing, show representative snippets, and link the source files.\n` +
          `3. Summarize the common patterns and any noteworthy variations.`,
        `Find examples of ${query}`,
      ),
  );

  if (opts.cloneEnabled) {
    server.registerPrompt(
      "kubesearch_review_repo",
      {
        title: "Clone & review a repo",
        description: "Temporarily clone a repository and review its Kubernetes/Flux/Helm setup.",
        argsSchema: { repo: z.string().min(1).describe("Indexed repo name (e.g. 'onedr0p/home-ops') or an https Git URL.") },
      },
      ({ repo }) =>
        userPrompt(
          `Review the Kubernetes setup in the "${repo}" repository.\n\n` +
            `1. Call repo_clone with "${repo}" and skim the returned file tree.\n` +
            `2. Use repo_list_files / repo_grep / repo_read_file to inspect its Flux/Helm/Kustomize layout ` +
            `(HelmReleases, Kustomizations, values, secrets handling, ingress, storage).\n` +
            `3. Review for best practices and risks: pinned vs floating chart/image versions, resource requests/limits, ` +
            `secret management (SOPS/sealed-secrets vs plaintext), security context, update automation, and structure.\n` +
            `4. Produce a concise findings report (strengths, issues by severity, concrete suggestions) citing file paths.\n` +
            `5. Call repo_cleanup with the handle when finished.`,
          `Review ${repo}`,
        ),
    );
  }
}
