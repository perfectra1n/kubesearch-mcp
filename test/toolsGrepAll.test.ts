import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { DataStore } from "../src/data/db.js";
import { RepoPool } from "../src/repo/pool.js";
import { buildServer } from "../src/server.js";
import { FakeGitRepoStore } from "./fakeGit.js";
import { makeFixtureCacheDir } from "./fixtures.js";

let root: string;
let cleanups: Array<() => void | Promise<void>>;

/** Build a real server over an in-memory transport with a synced fake-git pool of the given size. */
async function harness(poolSize: number): Promise<{ client: Client; store: FakeGitRepoStore }> {
  const fx = makeFixtureCacheDir("test");
  cleanups.push(fx.cleanup);
  const cfg = loadConfig({
    KUBESEARCH_CACHE_DIR: fx.cacheDir,
    KUBESEARCH_REFRESH_HOURS: "0",
    KUBESEARCH_CLONE_DIR: path.join(root, "clones"),
    KUBESEARCH_POOL_SIZE: String(poolSize),
    KUBESEARCH_POOL_MIN_RELEASES: "0",
  } as NodeJS.ProcessEnv);
  const data = new DataStore(cfg);
  cleanups.push(() => data.close());
  await data.ready();
  const store = new FakeGitRepoStore(cfg.clone, async (name) => data.getRepoByName(name));
  store.delayMs = 1;
  const pool = new RepoPool(cfg.clone.pool, cfg.clone.dir, store, data, cfg.refreshTtlMs);
  await pool.sync();
  // The fake clone writes only a README; give each member a manifest to grep.
  for (const r of store.pinned()) {
    fs.mkdirSync(path.join(r.dir, "apps"), { recursive: true });
    fs.writeFileSync(path.join(r.dir, "apps", "ingress.yaml"), `kind: Ingress\nhost: ${r.handle}\n`);
  }

  const server = buildServer(data, store, pool);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(ct), server.connect(st)]);
  cleanups.push(() => client.close());
  return { client, store };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-toolgrepall-"));
  cleanups = [];
});

afterEach(async () => {
  for (const c of cleanups.reverse()) await c();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("repo_grep_all tool", () => {
  it("is registered only when the pool is enabled", async () => {
    const withPool = await harness(2);
    expect((await withPool.client.listTools()).tools.map((t) => t.name)).toContain("repo_grep_all");

    const without = await harness(0);
    expect((await without.client.listTools()).tools.map((t) => t.name)).not.toContain("repo_grep_all");
  });

  it("greps every pool member and returns hits grouped by repo with followable handles", async () => {
    const { client } = await harness(2);

    const result = await client.callTool({ name: "repo_grep_all", arguments: { query: "kind: Ingress" } });
    const body = result.structuredContent as {
      pool: { size: number; ready: number; pending: string[]; failed: Array<{ repo: string; error: string }> };
      repos_searched: number;
      total_matches: number;
      repos: Array<{ handle: string; repo: string; stars: number; matches: Array<{ path: string; line: number; text: string }> }>;
    };

    expect(result.isError).toBeFalsy();
    expect(body.pool).toEqual({ size: 2, ready: 2, syncing: false, pending: [], failed: [] });
    expect(body.repos_searched).toBe(2);
    expect(body.total_matches).toBe(2);
    expect(body.repos.map((r) => r.handle)).toEqual(["bigstar/cluster", "onedr0p/home-ops"]);
    expect(body.repos[0]!.matches[0]).toEqual({ path: "apps/ingress.yaml", line: 1, text: "kind: Ingress" });
  });

  it("lets a hit be followed with repo_read_file using the returned handle", async () => {
    const { client } = await harness(1);
    const grep = await client.callTool({ name: "repo_grep_all", arguments: { query: "host:" } });
    const [hit] = (grep.structuredContent as { repos: Array<{ handle: string; matches: Array<{ path: string }> }> }).repos;

    const read = await client.callTool({ name: "repo_read_file", arguments: { handle: hit!.handle, path: hit!.matches[0]!.path } });

    expect(read.isError).toBeFalsy();
    expect((read.structuredContent as { content: string }).content).toContain("host: bigstar/cluster");
  });

  it("reports members that failed to clone alongside the results", async () => {
    // Build the harness by hand so the failure is injected before the sync.
    const fx = makeFixtureCacheDir("test");
    cleanups.push(fx.cleanup);
    const cfg = loadConfig({
      KUBESEARCH_CACHE_DIR: fx.cacheDir,
      KUBESEARCH_REFRESH_HOURS: "0",
      KUBESEARCH_CLONE_DIR: path.join(root, "clones"),
      KUBESEARCH_POOL_SIZE: "2",
      KUBESEARCH_POOL_MIN_RELEASES: "0",
    } as NodeJS.ProcessEnv);
    const data = new DataStore(cfg);
    cleanups.push(() => data.close());
    await data.ready();
    const store = new FakeGitRepoStore(cfg.clone, async () => null);
    store.delayMs = 1;
    store.failUrls = ["bigstar"];
    const pool = new RepoPool(cfg.clone.pool, cfg.clone.dir, store, data, cfg.refreshTtlMs);
    await pool.sync();
    const server = buildServer(data, store, pool);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([client.connect(ct), server.connect(st)]);
    cleanups.push(() => client.close());

    const result = await client.callTool({ name: "repo_grep_all", arguments: { query: "clone of" } });
    const body = result.structuredContent as {
      pool: { ready: number; failed: Array<{ repo: string; error: string }> };
      repos_searched: number;
    };

    expect(body.pool.ready).toBe(1);
    expect(body.pool.failed).toEqual([{ repo: "bigstar/cluster", error: expect.stringMatching(/not found/) }]);
    expect(body.repos_searched).toBe(1);
  });
});
