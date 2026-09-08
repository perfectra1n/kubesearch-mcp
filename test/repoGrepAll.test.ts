import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { RepoStore } from "../src/repo/clone.js";
import type { CloneRecord } from "../src/repo/types.js";

let root: string;
let store: RepoStore;

/** Register a working copy directly so grep can run without git or the network. */
function seed(target: RepoStore, handle: string, files: Record<string, string>, extra: Partial<CloneRecord> = {}): void {
  const dir = path.join(root, handle.replaceAll("/", "__"));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  const record: CloneRecord = {
    handle,
    key: `https://example.test/${handle}\nmain`,
    dir,
    url: `https://example.test/${handle}`,
    source: handle,
    branch: "main",
    createdAt: Date.now(),
    lastUsed: Date.now(),
    sizeBytes: 0,
    fileCount: Object.keys(files).length,
    ...extra,
  };
  (target as unknown as { records: Map<string, CloneRecord> }).records.set(handle, record);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-grepall-"));
  const cfg = loadConfig({ KUBESEARCH_CLONE_DIR: root } as NodeJS.ProcessEnv);
  store = new RepoStore(cfg.clone, async () => null);
  seed(store, "small/repo", { "apps/a.yaml": "kind: Ingress\nhost: a.example\n" }, { pinned: true, stars: 10 });
  seed(
    store,
    "big/repo",
    {
      "apps/b.yaml": "kind: Ingress\nkind: Ingress\n",
      "apps/c.yaml": "kind: Ingress\n",
      "docs/notes.md": "an Ingress note\n",
    },
    { pinned: true, stars: 500 },
  );
  seed(store, "ephemeral", { "x.yaml": "kind: Ingress\n" }); // not pinned → not part of the pool
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("RepoStore.grepAll", () => {
  it("groups hits by repo, most-starred first, and only searches pinned clones", async () => {
    const result = await store.grepAll("kind: Ingress");

    expect(result.repos_searched).toBe(2);
    expect(result.repos.map((r) => r.handle)).toEqual(["big/repo", "small/repo"]);
    expect(result.repos[0]).toMatchObject({ repo: "big/repo", stars: 500, match_count: 3, truncated: false });
    expect(result.repos[0]!.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["apps/b.yaml:1", "apps/b.yaml:2", "apps/c.yaml:1"]);
    expect(result.total_matches).toBe(4);
  });

  it("omits repos with no hits", async () => {
    const result = await store.grepAll("a.example");
    expect(result.repos.map((r) => r.handle)).toEqual(["small/repo"]);
    expect(result.repos_searched).toBe(2);
  });

  it("caps matches per repo and flags the repo as truncated", async () => {
    const result = await store.grepAll("kind: Ingress", { maxPerRepo: 2 });

    const big = result.repos.find((r) => r.handle === "big/repo")!;
    expect(big.matches).toHaveLength(2);
    expect(big.match_count).toBe(3);
    expect(big.truncated).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it("caps the total number of returned lines across repos", async () => {
    const result = await store.grepAll("Ingress", { limit: 3 });

    const returned = result.repos.reduce((n, r) => n + r.matches.length, 0);
    expect(returned).toBe(3);
    expect(result.total_matches).toBe(5); // counts are still complete
    expect(result.truncated).toBe(true);
  });

  it("applies the glob filter", async () => {
    const result = await store.grepAll("Ingress", { glob: "**/*.md" });
    expect(result.repos.map((r) => r.handle)).toEqual(["big/repo"]);
    expect(result.total_matches).toBe(1);
  });

  it("honours case sensitivity", async () => {
    expect((await store.grepAll("ingress", { caseSensitive: true })).total_matches).toBe(0);
    expect((await store.grepAll("ingress")).total_matches).toBe(5);
  });
});
