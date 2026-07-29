// Self-contained smoke test: spawns the built server over stdio and exercises
// the search tools, prompts, and the repo clone/review tools against live data.
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
console.log("ANNOTATIONS (search_releases):", JSON.stringify(tools.tools.find((t) => t.name === "kubesearch_search_releases")?.annotations));

const prompts = await client.listPrompts();
console.log("PROMPTS:", prompts.prompts.map((p) => p.name).join(", "));

const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const hr = await call("kubesearch_search_releases", { query: "cert-manager", limit: 3 });
console.log("\nsearch_releases cert-manager: total=%d top=%s count=%d", hr.total_matches, hr.results[0].id, hr.results[0].deployment_count);

const grepStart = performance.now();
const grep = await call("kubesearch_grep_values", { query: "cert-manager.io", limit: 2 });
console.log("grep_values cert-manager.io: total_files=%d has_more=%s (%dms)", grep.total_files, grep.has_more, Math.round(performance.now() - grepStart));

// paging must be disjoint and globally star-ranked
const grepPage2 = await call("kubesearch_grep_values", { query: "cert-manager.io", limit: 2, offset: 2 });
const page1Urls = new Set(grep.results.map((r) => r.file_url));
console.log("grep_values paging disjoint:", grepPage2.results.every((r) => !page1Urls.has(r.file_url)));

// structuredContent check
const raw = await client.callTool({ name: "kubesearch_status", arguments: {} });
console.log("status structuredContent tag:", raw.structuredContent?.tag);

// prompt interpolation
const p = await client.getPrompt({ name: "kubesearch_compare_deployments", arguments: { chart: "authentik" } });
console.log("prompt mentions authentik:", p.messages[0].content.text.includes("authentik"));

// --- repo clone/review flow ---
console.log("\n--- repo clone ---");
const clone = await call("repo_clone", { repo: "https://github.com/octocat/Hello-World" });
console.log("repo_clone: handle=%s files=%d branch=%s reused=%s", clone.handle?.slice(0, 8), clone.file_count, clone.branch, clone.reused);

// re-clone the same repo: should dedupe to the same handle and refresh (git fetch)
const recl = await call("repo_clone", { repo: "octocat/Hello-World" });
console.log("re-clone dedupe: sameHandle=%s reused=%s updated=%s", recl.handle === clone.handle, recl.reused, recl.updated);
const ls = await call("repo_list_files", { handle: clone.handle });
console.log("repo_list_files: %d entries", ls.entries.length);
const readme = ls.entries.find((e) => /readme/i.test(e.path)) ?? ls.entries.find((e) => e.type === "file");
const file = await call("repo_read_file", { handle: clone.handle, path: readme.path });
console.log("repo_read_file %s: %d bytes, starts: %j", file.path, file.bytes, file.content.slice(0, 40));
const rgrep = await call("repo_grep", { handle: clone.handle, query: "the" });
console.log("repo_grep 'the': total_matches=%d", rgrep.total_matches);

// traversal must be rejected
const escaped = await client.callTool({ name: "repo_read_file", arguments: { handle: clone.handle, path: "../../../../etc/passwd" } });
console.log("traversal rejected:", escaped.isError === true);

const cleaned = await call("repo_cleanup", { handle: clone.handle });
console.log("repo_cleanup removed:", cleaned.removed);

await client.close();
console.log("\nSMOKE OK");
process.exit(0);
