import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type CloneConfig } from "../src/config.js";
import { RepoStore } from "../src/repo/clone.js";

let root: string;

/**
 * A RepoStore whose git calls are replaced by a delay + a file write, so the
 * concurrency and dedupe behaviour can be exercised without git or a network.
 */
class FakeGitRepoStore extends RepoStore {
  clones = 0;
  updates = 0;
  concurrent = 0;
  peakConcurrent = 0;
  delayMs = 25;

  protected override async gitClone(url: string, dir: string): Promise<void> {
    this.clones++;
    this.concurrent++;
    this.peakConcurrent = Math.max(this.peakConcurrent, this.concurrent);
    try {
      await new Promise((r) => setTimeout(r, this.delayMs));
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, "README.md"), `clone of ${url}\n`);
    } finally {
      this.concurrent--;
    }
  }

  protected override async gitUpdate(): Promise<void> {
    this.updates++;
    await new Promise((r) => setTimeout(r, this.delayMs));
  }

  protected override async currentBranch(_dir: string, fallback: string | null): Promise<string> {
    return fallback ?? "main";
  }
}

function makeStore(overrides: Partial<CloneConfig> = {}): FakeGitRepoStore {
  const cfg = loadConfig({ KUBESEARCH_CLONE_DIR: path.join(root, "clones") } as NodeJS.ProcessEnv);
  return new FakeGitRepoStore({ ...cfg.clone, ...overrides }, async () => null);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ks-repostore-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("concurrent clones of the same repo", () => {
  it("runs git once and hands both callers the same handle", async () => {
    const store = makeStore();

    const [a, b] = await Promise.all([store.clone("octocat/Hello-World"), store.clone("octocat/Hello-World")]);

    expect(store.clones).toBe(1);
    expect(a.handle).toBe(b.handle);
    await store.cleanupAll();
  });

  it("leaves no orphaned working copy behind", async () => {
    const store = makeStore();

    await Promise.all([store.clone("octocat/Hello-World"), store.clone("octocat/Hello-World")]);

    const dirs = await fsp.readdir(path.join(root, "clones"));
    expect(dirs).toHaveLength(1);
    await store.cleanupAll();
  });

  it("does not run overlapping refreshes on one working copy", async () => {
    const store = makeStore({ refreshOnClone: true });
    await store.clone("octocat/Hello-World");

    await Promise.all([store.clone("octocat/Hello-World"), store.clone("octocat/Hello-World")]);

    expect(store.clones).toBe(1);
    expect(store.updates).toBeLessThanOrEqual(2);
    await store.cleanupAll();
  });
});

describe("clone concurrency cap", () => {
  it("never runs more git clones at once than the configured maximum", async () => {
    const store = makeStore({ maxRepos: 10, maxConcurrent: 2 });

    await Promise.all([
      store.clone("owner/one"),
      store.clone("owner/two"),
      store.clone("owner/three"),
      store.clone("owner/four"),
    ]);

    expect(store.clones).toBe(4);
    expect(store.peakConcurrent).toBeLessThanOrEqual(2);
    await store.cleanupAll();
  });
});

describe("startup orphan sweep", () => {
  it("removes working copies left behind by an ungraceful restart", async () => {
    const cloneDir = path.join(root, "clones");
    const orphan = path.join(cloneDir, "0f9d4a3e-1c2b-4a5d-8e7f-6a5b4c3d2e1f");
    const foreign = path.join(cloneDir, "not-a-clone");
    fs.mkdirSync(orphan, { recursive: true });
    fs.mkdirSync(foreign, { recursive: true });
    fs.writeFileSync(path.join(orphan, "stale.txt"), "x");

    const store = makeStore();
    await store.sweepOrphans();

    expect(fs.existsSync(orphan)).toBe(false);
    // Anything not shaped like one of our handles is left alone: the directory
    // may be shared or misconfigured, and deleting strangers' files is worse.
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it("does not remove a clone this process is actively using", async () => {
    const store = makeStore();
    const result = await store.clone("octocat/Hello-World");

    await store.sweepOrphans();

    expect(fs.existsSync(path.join(root, "clones", result.handle))).toBe(true);
    await store.cleanupAll();
  });
});
