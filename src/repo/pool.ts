import fsp from "node:fs/promises";
import path from "node:path";
import type { Database } from "better-sqlite3";
import type { PoolConfig } from "../config.js";
import { selectPoolRepos, type PoolMember } from "../domain/poolSelection.js";
import { log } from "../util/log.js";
import type { RepoStore } from "./clone.js";

/** The slice of DataStore the pool depends on. */
export interface PoolDataSource {
  ready(): Promise<void>;
  readonly database: Database;
  onSwap(listener: () => void): () => void;
}

export type PoolMemberState = "pending" | "ready" | "failed";

export interface PoolMemberStatus {
  repo: string;
  handle: string;
  stars: number;
  state: PoolMemberState;
  error?: string;
}

export interface PoolStatus {
  enabled: boolean;
  /** Configured target size (or the explicit list length). */
  size: number;
  ready: number;
  members: PoolMemberStatus[];
}

/** Pool dirs live under `<cloneDir>/pool/` as `<owner>__<repo>`; only names of that shape are ours to delete. */
const POOL_SUBDIR = "pool";
const SEGMENT = "[A-Za-z0-9._-]+";
const REPO_NAME_RE = new RegExp(`^${SEGMENT}(/${SEGMENT})+$`);
const POOL_DIR_RE = new RegExp(`^${SEGMENT}(__${SEGMENT})+$`);

/**
 * Keeps the top indexed repos permanently cloned so `repo_grep_all` can search
 * real manifests across them without a per-call clone. Membership comes from
 * the dataset (re-evaluated on every swap); working copies persist on disk so a
 * restart adopts them with a fetch. Nothing here blocks server start: `start()`
 * kicks off the first sync in the background and reports progress via status().
 */
export class RepoPool {
  private members = new Map<string, { member: PoolMember; state: PoolMemberState; error?: string }>();
  private inFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly cfg: PoolConfig,
    cloneDir: string,
    private readonly repos: RepoStore,
    private readonly data: PoolDataSource,
    private readonly refreshMs: number,
  ) {
    this.poolDir = path.join(cloneDir, POOL_SUBDIR);
  }

  private readonly poolDir: string;

  get enabled(): boolean {
    return this.cfg.size > 0 && this.repos.enabled;
  }

  /** Begin syncing in the background; re-sync on dataset swaps and on the refresh cadence. Returns stop. */
  start(): () => void {
    if (!this.enabled) return () => {};
    const kick = (): void => {
      void this.sync().catch((err) => log.warn(`pool sync failed: ${(err as Error).message}`));
    };
    kick();
    const offSwap = this.data.onSwap(kick);
    const timer = setInterval(kick, this.refreshMs);
    timer.unref?.();
    return () => {
      this.stopped = true;
      offSwap();
      clearInterval(timer);
    };
  }

  /**
   * Bring the pool in line with the current selection: pin new members, refresh
   * existing ones, drop the rest. Concurrent calls share one run.
   */
  sync(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (!this.inFlight) {
      this.inFlight = this.runSync().finally(() => {
        this.inFlight = null;
      });
    }
    return this.inFlight;
  }

  status(): PoolStatus {
    const members = [...this.members.values()].map(({ member, state, error }) => ({
      repo: member.repoName,
      handle: member.repoName,
      stars: member.stars,
      state,
      ...(error ? { error } : {}),
    }));
    return {
      enabled: this.enabled,
      size: this.cfg.repos.length > 0 ? this.cfg.repos.length : this.cfg.size,
      ready: members.filter((m) => m.state === "ready").length,
      members,
    };
  }

  private async runSync(): Promise<void> {
    await this.data.ready();
    if (this.stopped) return;
    const selection = selectPoolRepos(this.data.database, this.cfg);
    for (const name of selection.unknown) log.warn(`pool: "${name}" is not an indexed repo, skipping`);

    const desired = new Map<string, PoolMember>();
    for (const m of selection.members) {
      if (!REPO_NAME_RE.test(m.repoName) || m.repoName.split("/").includes("..")) {
        log.warn(`pool: refusing unusual repo name "${m.repoName}"`);
        continue;
      }
      desired.set(m.repoName, m);
    }

    // Drop members that fell out of the selection.
    for (const name of [...this.members.keys()]) {
      if (desired.has(name)) continue;
      this.members.delete(name);
      await this.repos.unpin(name);
    }
    await this.sweepPoolDir(new Set([...desired.keys()].map(dirName)));

    for (const [name, member] of desired) {
      const current = this.members.get(name);
      if (!current) this.members.set(name, { member, state: "pending" });
      else current.member = member;
    }

    await Promise.all(
      [...desired.values()].map(async (member) => {
        const entry = this.members.get(member.repoName)!;
        try {
          await this.repos.pin({
            handle: member.repoName,
            source: member.repoName,
            url: member.url,
            branch: member.branch,
            dir: path.join(this.poolDir, dirName(member.repoName)),
            stars: member.stars,
          });
          entry.state = "ready";
          delete entry.error;
        } catch (err) {
          entry.state = "failed";
          entry.error = (err as Error).message;
          log.warn(`pool: ${member.repoName} unavailable: ${entry.error}`);
        }
      }),
    );
    const { ready, members } = this.status();
    log(`pool synced: ${ready}/${members.length} repos ready`);
  }

  /** Remove pool-shaped directories that no current member owns (leftovers from an older selection). */
  private async sweepPoolDir(keep: Set<string>): Promise<void> {
    let entries: string[];
    try {
      entries = await fsp.readdir(this.poolDir);
    } catch {
      return;
    }
    await Promise.all(
      entries.map(async (entry) => {
        if (!POOL_DIR_RE.test(entry) || keep.has(entry)) return;
        await fsp.rm(path.join(this.poolDir, entry), { recursive: true, force: true });
        log(`pool: removed stale clone directory ${entry}`);
      }),
    );
  }
}

function dirName(repoName: string): string {
  return repoName.replaceAll("/", "__");
}
