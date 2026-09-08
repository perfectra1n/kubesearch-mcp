import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ KUBESEARCH_CACHE_DIR: "/tmp/ks-config-test", ...extra });

describe("pool config", () => {
  it("defaults to a 15-repo pool of repos with at least 20 HelmReleases", () => {
    const { pool } = loadConfig(env()).clone;
    expect(pool).toEqual({ size: 15, minReleases: 20, repos: [] });
  });

  it("reads size and threshold overrides", () => {
    const { pool } = loadConfig(env({ KUBESEARCH_POOL_SIZE: "3", KUBESEARCH_POOL_MIN_RELEASES: "0" })).clone;
    expect(pool.size).toBe(3);
    expect(pool.minReleases).toBe(0);
  });

  it("parses an explicit repo list, trimming blanks but preserving case and order", () => {
    const { pool } = loadConfig(env({ KUBESEARCH_POOL_REPOS: " onedr0p/home-ops, bjw-s-labs/Home-Ops ,, " })).clone;
    expect(pool.repos).toEqual(["onedr0p/home-ops", "bjw-s-labs/Home-Ops"]);
  });
});
