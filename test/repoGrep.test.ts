import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RepoStore } from "../src/repo/clone.js";
import type { CloneRecord } from "../src/repo/types.js";

let dir: string;
let store: RepoStore;
const HANDLE = "seeded-handle";

/**
 * Register a working copy directly, so grep can be exercised without git or
 * the network.
 */
function seedClone(target: RepoStore, cloneDir: string): void {
  const record: CloneRecord = {
    handle: HANDLE,
    key: "https://example.test/repo\nmain",
    dir: cloneDir,
    url: "https://example.test/repo",
    source: "example/repo",
    branch: "main",
    createdAt: Date.now(),
    lastUsed: Date.now(),
    sizeBytes: 0,
    fileCount: 1,
  };
  (target as unknown as { records: Map<string, CloneRecord> }).records.set(HANDLE, record);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "ks-repogrep-"));
  fs.writeFileSync(
    path.join(dir, "values.yaml"),
    ["image:", "  repository: ghcr.io/example/App", "  tag: v1", "replicas: 1 # app tuning", ""].join("\n"),
  );
  const cfg = loadConfig({ KUBESEARCH_CLONE_DIR: dir } as NodeJS.ProcessEnv);
  store = new RepoStore(cfg.clone, async () => null);
  seedClone(store, dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("RepoStore.grep case sensitivity", () => {
  it("matches case-insensitively by default", async () => {
    const result = await store.grep(HANDLE, "app");
    expect(result.total_matches).toBe(2); // "App" in the repository, "app tuning"
  });

  it("honours a case-sensitive search", async () => {
    const lower = await store.grep(HANDLE, "app", undefined, 100, true);
    expect(lower.total_matches).toBe(1);
    expect(lower.matches[0]!.text).toContain("app tuning");

    const upper = await store.grep(HANDLE, "App", undefined, 100, true);
    expect(upper.total_matches).toBe(1);
    expect(upper.matches[0]!.text).toContain("repository");
  });

  it("still caps the returned matches and flags truncation", async () => {
    const result = await store.grep(HANDLE, "a", undefined, 1);
    expect(result.matches).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.total_matches).toBeGreaterThan(1);
  });
});
