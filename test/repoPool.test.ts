import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type PoolConfig } from "../src/config.js";
import { RepoPool, type PoolDataSource } from "../src/repo/pool.js";
import { FakeGitRepoStore } from "./fakeGit.js";
import { makeFixtureDb } from "./fixtures.js";

let root: string;
let db: Database.Database;
let cleanupDb: () => void;
/** The listener RepoPool registered via onSwap, so a test can fire a dataset swap. */
let swapListener: (() => void) | null;

const POOL_DIR = () => path.join(root, "clones", "pool");
const dirOf = (name: string) => path.join(POOL_DIR(), name.replaceAll("/", "__"));

function dataSource(): PoolDataSource {
  return {
    ready: async () => {},
    get database() {
      return db;
    },
    onSwap(cb) {
      swapListener = cb;
      return () => {
        swapListener = null;
      };
    },
  };
}

function makePool(pool: Partial<PoolConfig> = {}, store?: FakeGitRepoStore): { pool: RepoPool; store: FakeGitRepoStore } {
  const cfg = loadConfig({ KUBESEARCH_CLONE_DIR: path.join(root, "clones") } as NodeJS.ProcessEnv).clone;
  const poolCfg: PoolConfig = { size: 2, minReleases: 0, repos: [], ...pool };
  const repos = store ?? new FakeGitRepoStore({ ...cfg, pool: poolCfg }, async () => null);
  repos.delayMs = 1;
  return { pool: new RepoPool(poolCfg, cfg.dir, repos, dataSource(), 60 * 60 * 1000), store: repos };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-pool-"));
  ({ db, cleanup: cleanupDb } = makeFixtureDb());
  swapListener = null;
});

afterEach(() => {
  cleanupDb();
  fs.rmSync(root, { recursive: true, force: true });
});

// Fixture: bigstar/cluster 9999★, onedr0p/home-ops 2819★, carpenike/k8s-gitops 309★.
describe("RepoPool.sync", () => {
  it("clones the selected members into deterministic pool directories and pins them", async () => {
    const { pool, store } = makePool();

    await pool.sync();

    expect(
      store
        .pinned()
        .map((r) => r.handle)
        .sort(),
    ).toEqual(["bigstar/cluster", "onedr0p/home-ops"]);
    expect(fs.existsSync(path.join(dirOf("bigstar/cluster"), "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(dirOf("onedr0p/home-ops"), "README.md"))).toBe(true);
    expect(pool.status()).toMatchObject({ enabled: true, size: 2, ready: 2 });
    expect(pool.status().members.map((m) => m.state)).toEqual(["ready", "ready"]);
  });

  it("adopts working copies left by a previous process with a fetch, not a clone", async () => {
    const first = makePool();
    await first.pool.sync();

    const second = makePool();
    await second.pool.sync();

    expect(second.store.clones).toBe(0);
    expect(second.store.updates).toBe(2);
    expect(second.pool.status().ready).toBe(2);
  });

  it("keeps going when one member fails and reports it", async () => {
    const { pool, store } = makePool();
    store.failUrls = ["bigstar"];

    await pool.sync();

    const status = pool.status();
    expect(status.ready).toBe(1);
    expect(status.members.find((m) => m.repo === "bigstar/cluster")).toMatchObject({
      state: "failed",
      error: expect.stringMatching(/not found/),
    });
    expect(status.members.find((m) => m.repo === "onedr0p/home-ops")).toMatchObject({ state: "ready", handle: "onedr0p/home-ops" });
  });

  it("removes members that dropped out of the selection, on disk and in the store", async () => {
    const first = makePool({ repos: ["bigstar/cluster", "onedr0p/home-ops"] });
    await first.pool.sync();

    const second = makePool({ repos: ["onedr0p/home-ops"] });
    await second.pool.sync();

    expect(fs.existsSync(dirOf("bigstar/cluster"))).toBe(false);
    expect(second.store.pinned().map((r) => r.handle)).toEqual(["onedr0p/home-ops"]);
  });

  it("does not delete unrelated directories under pool/", async () => {
    fs.mkdirSync(path.join(POOL_DIR(), "not a pool dir"), { recursive: true });
    const { pool } = makePool();

    await pool.sync();

    expect(fs.existsSync(path.join(POOL_DIR(), "not a pool dir"))).toBe(true);
  });

  it("re-syncs when the dataset swaps to a new release", async () => {
    const { pool, store } = makePool();
    const stop = pool.start();
    await pool.sync();
    expect(store.updates).toBe(0);

    swapListener!();
    await pool.sync(); // joins the swap-triggered sync

    expect(store.updates).toBe(2);
    stop();
    expect(swapListener).toBeNull();
  });

  it("is disabled when size is 0", async () => {
    const { pool, store } = makePool({ size: 0 });
    expect(pool.enabled).toBe(false);
    await pool.sync();
    expect(store.clones).toBe(0);
    expect(pool.status().enabled).toBe(false);
  });
});
