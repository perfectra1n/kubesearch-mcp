import fsp from "node:fs/promises";
import path from "node:path";
import { RepoStore } from "../src/repo/clone.js";

/**
 * A RepoStore whose git calls are replaced by a delay + a file write, so the
 * concurrency and dedupe behaviour can be exercised without git or a network.
 */
export class FakeGitRepoStore extends RepoStore {
  clones = 0;
  updates = 0;
  concurrent = 0;
  peakConcurrent = 0;
  delayMs = 25;

  /** URLs (substring match) whose clone should fail, to simulate a dead remote. */
  failUrls: string[] = [];

  protected override async gitClone(url: string, dir: string): Promise<void> {
    this.clones++;
    if (this.failUrls.some((f) => url.includes(f))) throw new Error(`fatal: repository '${url}' not found`);
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
