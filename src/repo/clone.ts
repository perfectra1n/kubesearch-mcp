import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { CloneConfig } from "../config.js";
import { log } from "../util/log.js";
import { Semaphore } from "../util/semaphore.js";
import { validateCloneUrl } from "./urlGuard.js";
import { curatedTree, globToRegExp, resolveInside, walkFiles } from "./fsSafe.js";
import type { CloneRecord, CloneResult, RepoFileContent, RepoFileListing, RepoGrepResult } from "./types.js";

const execFileAsync = promisify(execFile);

const OWNER_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const DEFAULT_READ_BYTES = 256 * 1024;
const GREP_FILE_MAX_BYTES = 1024 * 1024;
const LIST_MAX_ENTRIES = 500;

export type IndexedRepoResolver = (name: string) => Promise<{ url: string; branch: string | null } | null>;

export class RepoError extends Error {}

/** Handles are UUIDs; only directories shaped like one are ours to delete. */
const HANDLE_DIR_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RepoStore {
  private records = new Map<string, CloneRecord>();
  private timers = new Map<string, NodeJS.Timeout>();
  /** Dedupe index: "url\nbranch" -> handle, so re-cloning reuses one working copy. */
  private byKey = new Map<string, string>();
  /** In-progress clones by key, so concurrent callers share one git invocation. */
  private inFlight = new Map<string, Promise<CloneResult>>();
  private sweptOnce: Promise<void> | null = null;
  private readonly gitLimit: Semaphore;

  constructor(
    private readonly cfg: CloneConfig,
    private readonly resolveIndexed: IndexedRepoResolver,
  ) {
    this.gitLimit = new Semaphore(cfg.maxConcurrent);
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  // --- clone -------------------------------------------------------------

  async clone(source: string): Promise<CloneResult> {
    if (!this.cfg.enabled) throw new RepoError("Repository cloning is disabled (set KUBESEARCH_ENABLE_CLONE=true).");
    const input = source.trim();
    if (input === "") throw new RepoError("Empty repository reference.");

    let rawUrl = input;
    let branchHint: string | null = null;

    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && OWNER_REPO_RE.test(input)) {
      // An owner/repo shorthand: prefer the indexed clone URL + branch, else GitHub.
      const indexed = await this.resolveIndexed(input);
      if (indexed) {
        rawUrl = indexed.url;
        branchHint = indexed.branch;
      } else {
        rawUrl = `https://github.com/${input}`;
      }
    }

    const { url } = validateCloneUrl(rawUrl, this.cfg);
    const key = `${url}\n${branchHint ?? ""}`;

    // Join an in-progress clone of the same repo+branch. Nothing may await
    // between this lookup and the set below, or two callers would both miss and
    // race two `git clone`s into two directories for one repo.
    const running = this.inFlight.get(key);
    if (running) return running;

    const started = this.runClone(key, url, branchHint, input);
    this.inFlight.set(key, started);
    void started
      .catch(() => {})
      .finally(() => {
        if (this.inFlight.get(key) === started) this.inFlight.delete(key);
      });
    return started;
  }

  private async runClone(key: string, url: string, branchHint: string | null, input: string): Promise<CloneResult> {
    // Reuse (and optionally refresh) an existing clone of the same repo+branch.
    const existing = this.records.get(this.byKey.get(key) ?? "");
    if (existing) return this.reuse(existing);

    await this.ensureSwept();
    await fsp.mkdir(this.cfg.dir, { recursive: true });
    this.evictToCapacity();

    const handle = randomUUID();
    const dir = path.join(this.cfg.dir, handle);

    try {
      await this.gitLimit.run(() => this.gitClone(url, dir, branchHint));
    } catch (err) {
      await rmDir(dir);
      throw new RepoError(`git clone failed: ${cleanGitError((err as Error).message)}`);
    }

    const { files, size } = await walkFiles(dir);
    if (size > this.cfg.maxBytes) {
      await rmDir(dir);
      throw new RepoError(
        `Cloned tree is ${(size / 1024 / 1024).toFixed(1)} MB, exceeding the ${(this.cfg.maxBytes / 1024 / 1024).toFixed(0)} MB limit.`,
      );
    }

    const now = Date.now();
    const record: CloneRecord = {
      handle,
      key,
      dir,
      url,
      source: input,
      branch: await this.currentBranch(dir, branchHint),
      createdAt: now,
      lastUsed: now,
      sizeBytes: size,
      fileCount: files.length,
    };
    this.records.set(handle, record);
    this.byKey.set(key, handle);
    this.scheduleExpiry(record);
    log(`cloned ${url} -> ${handle} (${files.length} files, ${(size / 1024 / 1024).toFixed(1)} MB)`);
    return this.toResult(record, files, { reused: false, updated: false });
  }

  /** Reuse an existing clone, pulling the latest tip first when refreshOnClone is set. */
  private async reuse(record: CloneRecord): Promise<CloneResult> {
    let updated = false;
    if (this.cfg.refreshOnClone) {
      try {
        await this.gitLimit.run(() => this.gitUpdate(record.dir, record.branch));
        updated = true;
      } catch (err) {
        log.warn(`refresh of ${record.url} failed, serving existing copy: ${cleanGitError((err as Error).message)}`);
      }
    }
    const { files, size } = await walkFiles(record.dir);
    if (size > this.cfg.maxBytes) {
      await this.cleanup(record.handle);
      throw new RepoError(`Refreshed tree exceeds the ${(this.cfg.maxBytes / 1024 / 1024).toFixed(0)} MB limit.`);
    }
    record.sizeBytes = size;
    record.fileCount = files.length;
    record.lastUsed = Date.now();
    this.scheduleExpiry(record);
    log(`reused clone ${record.handle} for ${record.url}${updated ? " (refreshed)" : ""}`);
    return this.toResult(record, files, { reused: true, updated });
  }

  private toResult(record: CloneRecord, files: string[], flags: { reused: boolean; updated: boolean }): CloneResult {
    return {
      handle: record.handle,
      resolved_url: record.url,
      branch: record.branch,
      file_count: files.length,
      size_mb: Number((record.sizeBytes / 1024 / 1024).toFixed(2)),
      expires_in_minutes: Math.round(this.cfg.ttlMs / 60000),
      reused: flags.reused,
      updated: flags.updated,
      tree: curatedTree(files),
    };
  }

  private gitEnv(): NodeJS.ProcessEnv {
    return {
      PATH: process.env.PATH,
      HOME: this.cfg.dir,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_ASKPASS: "true",
      GIT_SSH_COMMAND: "false",
    };
  }

  private gitOpts(timeoutMs = this.cfg.timeoutMs) {
    return {
      env: this.gitEnv(),
      timeout: timeoutMs,
      killSignal: "SIGKILL" as const,
      windowsHide: true,
      // A chatty progress/warning stream on a big repo would otherwise blow
      // execFile's 1 MB default and fail the clone as ENOBUFS.
      maxBuffer: 16 * 1024 * 1024,
    };
  }

  protected async gitClone(url: string, dir: string, branch: string | null): Promise<void> {
    const base = ["clone", "--depth", "1", "--single-branch", "--no-tags", "--filter=blob:limit=2m"];
    try {
      const args = branch ? [...base, "--branch", branch, "--", url, dir] : [...base, "--", url, dir];
      await execFileAsync("git", args, this.gitOpts());
    } catch (err) {
      // The indexed branch may be stale; retry on the default branch.
      if (branch) {
        await rmDir(dir);
        await execFileAsync("git", [...base, "--", url, dir], this.gitOpts());
        return;
      }
      throw err;
    }
  }

  /** Shallow-fetch the latest tip and hard-reset the working tree to it. */
  protected async gitUpdate(dir: string, branch: string): Promise<void> {
    const ref = branch && branch !== "HEAD" ? branch : "HEAD";
    await execFileAsync("git", ["-C", dir, "fetch", "--depth", "1", "--no-tags", "origin", ref], this.gitOpts());
    await execFileAsync("git", ["-C", dir, "reset", "--hard", "FETCH_HEAD"], this.gitOpts());
    await execFileAsync("git", ["-C", dir, "clean", "-fdq"], this.gitOpts());
  }

  protected async currentBranch(dir: string, fallback: string | null): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", ["-C", dir, "rev-parse", "--abbrev-ref", "HEAD"], this.gitOpts(10000));
      const b = stdout.trim();
      if (b && b !== "HEAD") return b;
    } catch {
      /* ignore */
    }
    return fallback ?? "HEAD";
  }

  // --- navigation --------------------------------------------------------

  async list(handle: string, subPath = ".", glob?: string): Promise<RepoFileListing> {
    const record = this.touch(handle);
    const root = this.safePath(record, subPath);
    const matcher = glob ? globToRegExp(glob) : null;
    const entries: RepoFileListing["entries"] = [];
    let truncated = false;

    const walk = async (absDir: string): Promise<void> => {
      let dirents: fs.Dirent[];
      try {
        dirents = await fsp.readdir(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of dirents) {
        if (d.name === ".git" || d.isSymbolicLink()) continue;
        const abs = path.join(absDir, d.name);
        const rel = path.relative(record.dir, abs);
        if (d.isDirectory()) {
          if (!matcher) entries.push({ path: rel, type: "dir" });
          if (entries.length >= LIST_MAX_ENTRIES) {
            truncated = true;
            return;
          }
          await walk(abs);
          if (truncated) return;
        } else if (d.isFile()) {
          if (matcher && !matcher.test(rel)) continue;
          let size: number | undefined;
          try {
            size = (await fsp.stat(abs)).size;
          } catch {
            /* ignore */
          }
          entries.push({ path: rel, type: "file", size });
          if (entries.length >= LIST_MAX_ENTRIES) {
            truncated = true;
            return;
          }
        }
      }
    };
    await walk(root);

    entries.sort((a, b) => a.path.localeCompare(b.path));
    return { handle, path: path.relative(record.dir, root) || ".", entries, truncated };
  }

  async read(handle: string, relPath: string, maxBytes = DEFAULT_READ_BYTES): Promise<RepoFileContent> {
    const record = this.touch(handle);
    const abs = this.safePath(record, relPath);
    const stat = await fsp.stat(abs);
    if (!stat.isFile()) throw new RepoError(`Not a file: ${relPath}`);

    const cap = Math.min(maxBytes, 4 * 1024 * 1024);
    const fh = await fsp.open(abs, "r");
    try {
      const buf = Buffer.alloc(Math.min(stat.size, cap + 1));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const slice = buf.subarray(0, bytesRead);
      if (slice.includes(0)) throw new RepoError(`Refusing to read binary file: ${relPath}`);
      const truncated = bytesRead > cap;
      const content = slice.subarray(0, Math.min(bytesRead, cap)).toString("utf-8");
      return { handle, path: path.relative(record.dir, abs), content, bytes: stat.size, truncated };
    } finally {
      await fh.close();
    }
  }

  async grep(handle: string, query: string, glob?: string, maxResults = 100, caseSensitive = false): Promise<RepoGrepResult> {
    const record = this.touch(handle);
    if (query === "") throw new RepoError("Empty grep query.");
    const matcher = glob ? globToRegExp(glob) : null;
    const needle = caseSensitive ? query : query.toLowerCase();
    const { files } = await walkFiles(record.dir);
    const matches: RepoGrepResult["matches"] = [];
    let total = 0;
    let truncated = false;

    for (const rel of files) {
      if (matcher && !matcher.test(rel)) continue;
      const abs = path.join(record.dir, rel);
      let stat: fs.Stats;
      try {
        stat = await fsp.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > GREP_FILE_MAX_BYTES) continue;
      let text: string;
      try {
        text = await fsp.readFile(abs, "utf-8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const haystack = caseSensitive ? lines[i]! : lines[i]!.toLowerCase();
        if (haystack.includes(needle)) {
          total++;
          if (matches.length < maxResults) {
            const line = lines[i]!;
            matches.push({ path: rel, line: i + 1, text: line.length > 240 ? line.slice(0, 240) + "…" : line.trim() });
          } else {
            truncated = true;
          }
        }
      }
    }
    return { handle, query, total_matches: total, matches, truncated };
  }

  // --- lifecycle ---------------------------------------------------------

  async cleanup(handle: string): Promise<boolean> {
    const record = this.records.get(handle);
    if (!record) return false;
    this.clearTimer(handle);
    this.records.delete(handle);
    if (this.byKey.get(record.key) === handle) this.byKey.delete(record.key);
    await rmDir(record.dir);
    log(`cleaned up clone ${handle}`);
    return true;
  }

  /**
   * Delete clone directories this process doesn't know about. Clone state lives
   * only in memory, so an ungraceful exit (OOM kill, crash, SIGKILL) strands
   * every working copy on the volume with nothing left to reap it.
   *
   * Only UUID-shaped directories are touched: the clone dir may be shared or
   * misconfigured, and deleting someone else's files is worse than leaking.
   */
  async sweepOrphans(): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(this.cfg.dir, { withFileTypes: true });
    } catch {
      return; // nothing cloned yet
    }
    const live = new Set([...this.records.values()].map((r) => path.basename(r.dir)));
    await Promise.all(
      entries.map(async (entry) => {
        if (!entry.isDirectory() || !HANDLE_DIR_RE.test(entry.name) || live.has(entry.name)) return;
        await rmDir(path.join(this.cfg.dir, entry.name));
        log(`removed orphaned clone directory ${entry.name}`);
      }),
    );
  }

  /** Sweep once before the first clone, so it can't delete a fresh working copy. */
  private ensureSwept(): Promise<void> {
    if (!this.sweptOnce) this.sweptOnce = this.sweepOrphans();
    return this.sweptOnce;
  }

  async cleanupAll(): Promise<void> {
    const handles = [...this.records.keys()];
    await Promise.all(handles.map((h) => this.cleanup(h)));
    // Best-effort removal of the whole clones dir (stray temp dirs).
    await rmDir(this.cfg.dir);
  }

  // --- internals ---------------------------------------------------------

  private touch(handle: string): CloneRecord {
    const record = this.records.get(handle);
    if (!record) {
      throw new RepoError(`Unknown or expired clone handle "${handle}". Clone the repository again with repo_clone.`);
    }
    record.lastUsed = Date.now();
    this.scheduleExpiry(record); // reset TTL on use
    return record;
  }

  /** Resolve a relative path inside a clone, rejecting `..`/symlink escapes. */
  private safePath(record: CloneRecord, rel: string): string {
    return resolveInside(record.dir, rel);
  }

  private evictToCapacity(): void {
    while (this.records.size >= this.cfg.maxRepos) {
      let oldest: CloneRecord | undefined;
      for (const r of this.records.values()) if (!oldest || r.lastUsed < oldest.lastUsed) oldest = r;
      if (!oldest) break;
      void this.cleanup(oldest.handle);
    }
  }

  private scheduleExpiry(record: CloneRecord): void {
    this.clearTimer(record.handle);
    const timer = setTimeout(() => void this.cleanup(record.handle), this.cfg.ttlMs);
    timer.unref?.();
    this.timers.set(record.handle, timer);
  }

  private clearTimer(handle: string): void {
    const t = this.timers.get(handle);
    if (t) {
      clearTimeout(t);
      this.timers.delete(handle);
    }
  }
}

// --- helpers -------------------------------------------------------------

function cleanGitError(message: string): string {
  return message
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-3)
    .join("; ")
    .slice(0, 300);
}

async function rmDir(dir: string): Promise<void> {
  try {
    await fsp.rm(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}
