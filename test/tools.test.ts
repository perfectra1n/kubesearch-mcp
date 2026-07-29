import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DataStore } from "../src/data/db.js";
import { RepoStore } from "../src/repo/clone.js";
import { buildServer } from "../src/server.js";
import { makeFixtureCacheDir } from "./fixtures.js";

let client: Client;
let store: DataStore;
let cleanupDir: () => void;

/** Drive the real server over an in-memory transport, backed by the fixture DB. */
beforeAll(async () => {
  const fx = makeFixtureCacheDir("test");
  cleanupDir = fx.cleanup;
  const cfg = loadConfig({
    KUBESEARCH_CACHE_DIR: fx.cacheDir,
    KUBESEARCH_REFRESH_HOURS: "0",
  } as NodeJS.ProcessEnv);
  store = new DataStore(cfg);
  await store.ready();
  const repos = new RepoStore(cfg.clone, async (name) => store.getRepoByName(name));
  const server = buildServer(store, repos);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "kubesearch-mcp-test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterAll(async () => {
  await client.close();
  store.close();
  cleanupDir();
});

function textOf(result: unknown): string {
  return (result as { content: Array<{ type: string; text: string }> }).content[0]!.text;
}

describe("tool response envelope", () => {
  it("serializes text compactly and equivalently to structuredContent", async () => {
    const result = await client.callTool({ name: "kubesearch_search_releases", arguments: { query: "cert-manager" } });
    const text = textOf(result);

    expect(text).not.toContain("\n");
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it("declares an outputSchema on every tool, repo tools included", async () => {
    const { tools } = await client.listTools();
    const withoutSchema = tools.filter((t) => !t.outputSchema).map((t) => t.name);

    expect(tools.length).toBeGreaterThan(5);
    expect(withoutSchema).toEqual([]);
  });

  it("reports a failed tool call as an error result rather than throwing", async () => {
    const result = await client.callTool({ name: "kubesearch_get_release", arguments: { id: "does-not-exist" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/does-not-exist/);
  });
});

describe("search tools over fixture data", () => {
  it("finds the cert-manager release group", async () => {
    const result = await client.callTool({ name: "kubesearch_search_releases", arguments: { query: "cert-manager" } });
    const body = result.structuredContent as { total_matches: number; results: Array<{ id: string }> };
    expect(body.total_matches).toBeGreaterThan(0);
    expect(body.results.some((r) => r.id.includes("cert-manager"))).toBe(true);
  });

  it("greps values and reports paging state", async () => {
    const result = await client.callTool({
      name: "kubesearch_grep_values",
      arguments: { query: "installCRDs", limit: 1 },
    });
    const body = result.structuredContent as { total_files: number; shown: number; has_more: boolean };
    expect(body.total_files).toBe(3);
    expect(body.shown).toBe(1);
    expect(body.has_more).toBe(true);
  });
});
