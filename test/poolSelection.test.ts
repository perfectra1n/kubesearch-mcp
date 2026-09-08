import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { selectPoolRepos } from "../src/domain/poolSelection.js";
import { makeFixtureDb } from "./fixtures.js";

let db: Database.Database;
let cleanup: () => void;

beforeAll(() => {
  ({ db, cleanup } = makeFixtureDb());
});
afterAll(() => cleanup());

// Fixture: bigstar/cluster 9999★ (1 HR), onedr0p/home-ops 2819★ (2 HRs), carpenike/k8s-gitops 309★ (1 HR).
describe("selectPoolRepos by stars", () => {
  it("ranks by stars and caps at size", () => {
    const { members } = selectPoolRepos(db, { size: 2, minReleases: 0, repos: [] });
    expect(members.map((r) => r.repoName)).toEqual(["bigstar/cluster", "onedr0p/home-ops"]);
  });

  it("drops repos below the HelmRelease threshold even when highly starred", () => {
    const { members } = selectPoolRepos(db, { size: 10, minReleases: 2, repos: [] });
    expect(members.map((r) => r.repoName)).toEqual(["onedr0p/home-ops"]);
  });

  it("carries the clone url, branch and stars for each member", () => {
    const [top] = selectPoolRepos(db, { size: 1, minReleases: 0, repos: [] }).members;
    expect(top).toEqual({ repoName: "bigstar/cluster", url: "https://github.com/bigstar/cluster", branch: "main", stars: 9999 });
  });
});

describe("selectPoolRepos with an explicit list", () => {
  it("keeps the caller's order and ignores size and threshold", () => {
    const { members } = selectPoolRepos(db, { size: 1, minReleases: 99, repos: ["carpenike/k8s-gitops", "onedr0p/home-ops"] });
    expect(members.map((r) => r.repoName)).toEqual(["carpenike/k8s-gitops", "onedr0p/home-ops"]);
  });

  it("skips names that are not indexed and reports them", () => {
    const { members, unknown } = selectPoolRepos(db, { size: 1, minReleases: 0, repos: ["nobody/nothing", "onedr0p/home-ops"] });
    expect(members.map((r) => r.repoName)).toEqual(["onedr0p/home-ops"]);
    expect(unknown).toEqual(["nobody/nothing"]);
  });
});
