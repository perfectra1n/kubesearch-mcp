import { describe, expect, it } from "vitest";
import { buildValuesPage, filterByRepo } from "../src/tools/search/getRelease.js";
import type { Deployment } from "../src/domain/types.js";

function dep(repo: string, fileUrl: string): Deployment {
  return {
    key: "key",
    chart: "chart",
    release: "release",
    namespace: null,
    chartVersion: null,
    chartSourceUrl: "https://example.test",
    sourceUrl: "https://example.test",
    sourceKind: null,
    sourceTag: null,
    resolvedChart: null,
    helmRepoName: "",
    repo,
    repoUrl: null,
    stars: 0,
    fileUrl,
    timestamp: "2026-01-01T00:00:00Z",
    icon: null,
    group: null,
  };
}

const BIG = { blob: "x".repeat(5000) };
const SMALL = { replicaCount: 1 };

describe("buildValuesPage", () => {
  it("returns the first entry's values even when it alone blows the budget", () => {
    // Otherwise an oversized document is unreachable: paging past it doesn't
    // help, because it is still first on whatever page contains it.
    const page = [dep("a/one", "u1")];
    const values = new Map<string, unknown>([["u1", BIG]]);

    const result = buildValuesPage(page, values, undefined, 100);

    expect(result.deployments[0]!.values).toEqual(BIG);
    expect(result.deployments[0]!.values_omitted).toBeUndefined();
    expect(result.omitted).toBe(0);
  });

  it("omits only the oversized entry and keeps filling with the smaller ones after it", () => {
    const page = [dep("a/one", "u1"), dep("b/two", "u2"), dep("c/three", "u3")];
    const values = new Map<string, unknown>([
      ["u1", SMALL],
      ["u2", BIG],
      ["u3", SMALL],
    ]);

    const result = buildValuesPage(page, values, undefined, 1000);

    expect(result.deployments[0]!.values).toEqual(SMALL);
    expect(result.deployments[1]!.values).toBeUndefined();
    expect(result.deployments[1]!.values_omitted).toContain("b/two");
    expect(result.deployments[2]!.values).toEqual(SMALL);
    expect(result.omitted).toBe(1);
  });

  it("returns every entry when they all fit", () => {
    const page = [dep("a/one", "u1"), dep("b/two", "u2")];
    const values = new Map<string, unknown>([
      ["u1", SMALL],
      ["u2", SMALL],
    ]);

    const result = buildValuesPage(page, values, undefined, 1000);

    expect(result.omitted).toBe(0);
    expect(result.deployments.every((d) => d.values !== undefined)).toBe(true);
  });

  it("suggests narrowing rather than paging, since a higher offset cannot help", () => {
    const page = [dep("a/one", "u1"), dep("b/two", "u2")];
    const values = new Map<string, unknown>([
      ["u1", SMALL],
      ["u2", BIG],
    ]);

    const omitted = buildValuesPage(page, values, undefined, 1000).deployments[1]!.values_omitted as string;

    expect(omitted).toContain("value_paths");
    expect(omitted).not.toContain("offset");
  });

  it("projects value_paths so an otherwise-oversized document fits", () => {
    const page = [dep("a/one", "u1")];
    const values = new Map<string, unknown>([["u1", { keep: 1, drop: "x".repeat(5000) }]]);

    const result = buildValuesPage(page, values, ["keep"], 1000);

    expect(result.deployments[0]!.values).toEqual({ keep: 1 });
  });
});

describe("filterByRepo", () => {
  const deployments = [dep("prod/app", "u1"), dep("prod/app-staging", "u2")];

  it("prefers an exact repo match over the repos it is a prefix of", () => {
    expect(filterByRepo(deployments, "prod/app").map((d) => d.repo)).toEqual(["prod/app"]);
  });

  it("falls back to substring matching when nothing matches exactly", () => {
    expect(filterByRepo(deployments, "app").map((d) => d.repo)).toEqual(["prod/app", "prod/app-staging"]);
  });

  it("is case-insensitive", () => {
    expect(filterByRepo(deployments, "PROD/APP").map((d) => d.repo)).toEqual(["prod/app"]);
  });

  it("returns nothing when there is no match at all", () => {
    expect(filterByRepo(deployments, "nope")).toEqual([]);
  });
});
