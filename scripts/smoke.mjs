// Self-contained smoke test: spawns the built server over stdio and exercises
// every tool against whatever data is in KUBESEARCH_CACHE_DIR.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: ["dist/index.js"],
  env: { ...process.env, MCP_TRANSPORT: "stdio", KUBESEARCH_REFRESH_HOURS: "0" },
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
console.log("TOOLS:", tools.tools.map((t) => t.name).join(", "));

const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const hr = await call("search_helm_releases", { query: "cert-manager", limit: 3 });
console.log("\nsearch_helm_releases cert-manager: total=%d top=%s count=%d", hr.total_matches, hr.results[0].id, hr.results[0].deployment_count);
console.log("  top repos:", hr.results[0].top_repos.slice(0, 3).map((r) => `${r.repo}(${r.stars}*)`).join(", "));
console.log("  url:", hr.results[0].kubesearch_url);

const detail = await call("get_helm_release", { id: "ghcr.io-home-operations-charts-mirror-cert-manager", include_values: true });
console.log("\nget_helm_release: chart=%s deployments=%d firstHasValues=%s", detail.chart, detail.deployment_count, !!detail.deployments[0].values);

const grep = await call("grep_values", { query: "cert-manager.io", limit: 3 });
console.log("\ngrep_values cert-manager.io: total_files=%d sample=%s :: %s", grep.total_files, grep.results[0].repo, grep.results[0].matched_key);

const img = await call("search_images", { query: "cert-manager", limit: 4 });
console.log("\nsearch_images cert-manager: total=%d", img.total_matches);
for (const e of img.results.slice(0, 4)) console.log("  -", e.repository, "tags=" + e.tag_count, "used=" + e.usage_count);

const status = await call("kubesearch_status", {});
console.log("\nstatus:", JSON.stringify(status));

await client.close();
console.log("\nSMOKE OK");
process.exit(0);
