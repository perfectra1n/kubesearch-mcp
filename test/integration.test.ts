import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { makeFixtureDb } from "./fixtures.js";
import { buildReleaseIndex, searchReleaseGroups } from "../src/domain/helmReleases.js";
import { mergeHelmURL, releaseKey } from "../src/domain/releaseKey.js";
import { buildImageIndex, searchImages } from "../src/domain/images.js";
import { grepValues } from "../src/domain/grep.js";
import { summarizeValues } from "../src/domain/valuesSummary.js";
import type { ReleaseIndex } from "../src/domain/types.js";

/** Mirror DataStore.getValues over the fixture's attached ext db. */
function fixtureValues(database: Database.Database, urls: string[]): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (urls.length === 0) return out;
  const placeholders = urls.map(() => "?").join(",");
  const rows = database
    .prepare(
      `select url, val from (
         select url, val from ext.flux_helm_release_values
         union all
         select url, val from ext.argo_helm_application_values
       ) where url in (${placeholders})`,
    )
    .all(...urls) as Array<{ url: string; val: string | null }>;
  for (const r of rows) if (r.val) out.set(r.url, JSON.parse(r.val));
  return out;
}

let db: Database.Database;
let cleanup: () => void;
let index: ReleaseIndex;

beforeAll(() => {
  const fx = makeFixtureDb();
  db = fx.db;
  cleanup = fx.cleanup;
  index = buildReleaseIndex(db);
});

afterAll(() => cleanup());

describe("buildReleaseIndex + search", () => {
  it("groups cert-manager by chart source and produces the OCI slug", () => {
    const { total, groups } = searchReleaseGroups(index, "cert-manager", 25, 0);
    expect(total).toBeGreaterThanOrEqual(2); // OCI group + jetstack helm-repo group
    const oci = groups.find((g) => g.id === "ghcr.io-home-operations-charts-mirror-cert-manager");
    expect(oci).toBeDefined();
    expect(oci!.deployments[0]!.repo).toBe("onedr0p/home-ops");
  });

  it("round-trips: a searched id resolves in the group map", () => {
    const { groups } = searchReleaseGroups(index, "cert-manager", 5, 0);
    const id = groups[0]!.id;
    expect(index.groups.get(id)).toBeDefined();
  });
});

describe("chartRef / OCIRepository raw source", () => {
  const homepageId = releaseKey(mergeHelmURL("oci://ghcr.io/bjw-s-labs/helm/app-template"), "homepage", "homepage");

  it("keeps the collapsed group id (link parity) — does not change with the fix", () => {
    expect(homepageId).toBe("ghcr.io-bjw-s-labs-charts-homepage");
    expect(index.groups.get(homepageId)).toBeDefined();
  });

  it("preserves the normalized chart_source_url at the group level", () => {
    const group = index.groups.get(homepageId)!;
    expect(group.chartSourceUrl).toBe("oci://ghcr.io/bjw-s-labs/charts/");
  });

  it("surfaces the real chart via raw source fields", () => {
    const group = index.groups.get(homepageId)!;
    const dep = group.deployments[0]!;
    expect(dep.sourceUrl).toBe("oci://ghcr.io/bjw-s-labs/helm/app-template");
    expect(dep.sourceKind).toBe("OCIRepository");
    expect(dep.sourceTag).toBe("5.0.1");
    expect(dep.resolvedChart).toBe("app-template");
    expect(group.resolvedChart).toBe("app-template");
    expect(group.sourceUrls).toEqual(["oci://ghcr.io/bjw-s-labs/helm/app-template"]);
    expect(group.chartSourceAmbiguous).toBe(false);
  });

  it("does not fake-resolve a chart for HelmRepository (repo-root) sources", () => {
    const group = index.groups.get("ghcr.io-home-operations-charts-mirror-cert-manager");
    // cross-check the jetstack HelmRepository deployment from the other group
    const { groups } = searchReleaseGroups(index, "cert-manager", 25, 0);
    const jetstack = groups.flatMap((g) => g.deployments).find((d) => d.sourceUrl === "https://charts.jetstack.io");
    expect(jetstack).toBeDefined();
    expect(jetstack!.sourceKind).toBe("HelmRepository");
    expect(jetstack!.resolvedChart).toBeNull();
    expect(group).toBeDefined();
  });
});

describe("grepValues", () => {
  it("finds cert-manager.io across values with key path + context", () => {
    const res = grepValues(db, index, "cert-manager.io", 30, false);
    expect(res.totalFiles).toBeGreaterThanOrEqual(1);
    const match = res.matches[0]!;
    expect(match.repo).toBe("onedr0p/home-ops");
    expect(match.matchedKey).toContain("cert-manager.io");
  });

  it("respects case sensitivity", () => {
    expect(grepValues(db, index, "CERT-MANAGER.IO", 30, true).totalFiles).toBe(0);
    expect(grepValues(db, index, "CERT-MANAGER.IO", 30, false).totalFiles).toBeGreaterThanOrEqual(1);
  });
});

describe("summarizeValues over the release index", () => {
  it("digests how the cert-manager group is configured", () => {
    const group = index.groups.get("ghcr.io-home-operations-charts-mirror-cert-manager")!;
    const valuesByUrl = fixtureValues(db, group.deployments.map((d) => d.fileUrl));
    const summary = summarizeValues(group.deployments, valuesByUrl, { top: 25, examples: 1 });
    expect(summary.analyzedDeployments).toBe(group.deployments.length);
    const installCrds = summary.commonSettings.find((c) => c.path === "installCRDs");
    expect(installCrds).toBeDefined();
    expect(installCrds!.values[0]!.value).toBe("true");
    expect(summary.examples[0]!.repo).toBe("onedr0p/home-ops");
  });
});

describe("images", () => {
  it("indexes nested image.repository and supports substring search", () => {
    const imageIndex = buildImageIndex(db);
    const { entries } = searchImages(imageIndex, "cert-manager", 25);
    const entry = entries.find((e) => e.repository === "quay.io/jetstack/cert-manager-controller");
    expect(entry).toBeDefined();
    expect(entry!.tags).toContain("v1.14.0");
    expect(entry!.usageCount).toBe(1);
  });
});
