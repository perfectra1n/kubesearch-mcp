import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { makeFixtureDb } from "./fixtures.js";
import { buildReleaseIndex, searchReleaseGroups } from "../src/domain/helmReleases.js";
import { buildImageIndex, searchImages } from "../src/domain/images.js";
import { grepValues } from "../src/domain/grep.js";
import type { ReleaseIndex } from "../src/domain/types.js";

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
