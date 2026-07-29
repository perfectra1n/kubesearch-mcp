import fs from "node:fs";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { log } from "../util/log.js";
import { resolveLatestTag } from "./releases.js";
import {
  downloadDatabases,
  filesExist,
  pruneOldTags,
  readMeta,
  reposDbPath,
  reposExtendedDbPath,
  sweepStaleTmp,
  writeMeta,
  type CacheMeta,
  type DownloadOptions,
} from "./cache.js";
import type { PriorRelease } from "./releases.js";
import { optimizeDatabases } from "./optimize.js";
import { prepared } from "./stmtCache.js";
import { buildReleaseIndex } from "../domain/helmReleases.js";
import { buildImageIndex } from "../domain/images.js";
import type { ImageIndex, ReleaseIndex } from "../domain/types.js";

export interface DataStatus {
  tag: string;
  cacheDir: string;
  loadedAt: string;
  releaseFiles: number;
  reposIndexed: number;
  helmReleases: number;
  ociRepositories: number;
  valueDocuments: number;
}

/**
 * Owns the SQLite connection and its lifecycle: lazy first-load, freshness-based
 * background refresh, atomic swap to a newer release, and cached derived indexes.
 */
export class DataStore {
  private db: Database.Database | null = null;
  private tag: string | null = null;
  private loadedAt = 0;
  private lastCheckedAt = 0;
  private refreshFailures = 0;
  private initPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  // The in-flight promise *is* the cache, so concurrent callers share one build.
  private releaseIndexPromise: Promise<ReleaseIndex> | null = null;
  private imageIndexPromise: Promise<ImageIndex> | null = null;
  private buildsInFlight = new Set<Promise<unknown>>();
  private closed = false;

  constructor(private readonly cfg: Config) {}

  private downloadOptions(): DownloadOptions {
    return { timeoutMs: this.cfg.downloadTimeoutMs, maxBytes: this.cfg.maxDbBytes };
  }

  private priorRelease(meta: CacheMeta | undefined): PriorRelease | undefined {
    return meta?.etag ? { tag: meta.tag, etag: meta.etag } : undefined;
  }

  /** Ensure data is loaded; trigger a non-blocking refresh if the TTL elapsed. */
  async ready(): Promise<void> {
    if (!this.db) {
      if (!this.initPromise) this.initPromise = this.load().catch((err) => { this.initPromise = null; throw err; });
      await this.initPromise;
      return;
    }
    void this.maybeRefresh();
  }

  private async load(): Promise<void> {
    const { cacheDir, upstreamRepo, githubToken, refreshTtlMs } = this.cfg;
    await fs.promises.mkdir(cacheDir, { recursive: true });
    await sweepStaleTmp(cacheDir);
    const meta = readMeta(cacheDir);

    const cacheStillFresh = !this.cfg.autoRefresh || Date.now() - (meta?.fetchedAt ?? 0) < refreshTtlMs;
    if (meta && filesExist(cacheDir, meta.tag) && cacheStillFresh) {
      log(`using cached databases (tag ${meta.tag})`);
      this.open(meta.tag);
      this.lastCheckedAt = Date.now();
      return;
    }

    let latest: string;
    let etag: string | null;
    try {
      const resolved = await resolveLatestTag(upstreamRepo, githubToken, this.priorRelease(meta));
      latest = resolved.tag;
      etag = resolved.etag;
    } catch (err) {
      if (meta && filesExist(cacheDir, meta.tag)) {
        log.warn(`release check failed (${(err as Error).message}); serving cached tag ${meta.tag}`);
        this.open(meta.tag);
        this.lastCheckedAt = Date.now();
        return;
      }
      throw err;
    }

    if (!filesExist(cacheDir, latest)) {
      log(`fetching databases for release ${latest}…`);
      await downloadDatabases(upstreamRepo, latest, cacheDir, this.downloadOptions());
    }
    await writeMeta(cacheDir, { tag: latest, fetchedAt: Date.now(), ...(etag ? { etag } : {}) });
    await pruneOldTags(cacheDir, latest);
    this.open(latest);
    this.lastCheckedAt = Date.now();
  }

  /** Effective re-check interval: full TTL normally, short exponential backoff after failures. */
  private effectiveTtlMs(): number {
    if (this.refreshFailures === 0) return this.cfg.refreshTtlMs;
    const backoff = 5 * 60_000 * 2 ** (this.refreshFailures - 1);
    return Math.min(this.cfg.refreshTtlMs, backoff, 60 * 60_000);
  }

  private maybeRefresh(): Promise<void> {
    if (!this.cfg.autoRefresh) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    if (Date.now() - this.lastCheckedAt < this.effectiveTtlMs()) return Promise.resolve();
    return this.runRefresh();
  }

  private runRefresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.refresh()
      .then(() => { this.refreshFailures = 0; })
      .catch((err) => {
        this.refreshFailures++;
        log.warn(`background refresh failed: ${(err as Error).message}`);
      })
      .finally(() => {
        this.lastCheckedAt = Date.now();
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  /**
   * Start a proactive timer that re-checks for a newer release, independent of
   * incoming requests (important for a long-running HTTP deploy). The tick is
   * short; `maybeRefresh` decides whether the TTL (or failure backoff) elapsed.
   * Returns a stop function. No-op when auto-refresh is disabled.
   */
  startAutoRefresh(): () => void {
    if (!this.cfg.autoRefresh) return () => {};
    const timer = setInterval(() => {
      if (this.db) void this.maybeRefresh();
    }, Math.min(this.cfg.refreshTtlMs, 5 * 60_000));
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async refresh(): Promise<void> {
    const { cacheDir, upstreamRepo, githubToken } = this.cfg;
    const meta = readMeta(cacheDir);
    const resolved = await resolveLatestTag(upstreamRepo, githubToken, this.priorRelease(meta));
    const latest = resolved.tag;
    if (latest === this.tag) {
      if (!resolved.notModified && resolved.etag && resolved.etag !== meta?.etag) {
        await writeMeta(cacheDir, { tag: latest, fetchedAt: meta?.fetchedAt ?? Date.now(), etag: resolved.etag });
      }
      return;
    }
    if (!filesExist(cacheDir, latest)) {
      log(`newer release available (${latest}); downloading…`);
      await downloadDatabases(upstreamRepo, latest, cacheDir, this.downloadOptions());
    }
    await writeMeta(cacheDir, { tag: latest, fetchedAt: Date.now(), ...(resolved.etag ? { etag: resolved.etag } : {}) });
    this.open(latest);
    await pruneOldTags(cacheDir, latest);
    log(`swapped to release ${latest}`);
  }

  private open(tag: string): void {
    optimizeDatabases(this.cfg.cacheDir, tag);
    const old = this.db;
    const db = new Database(reposDbPath(this.cfg.cacheDir, tag), { readonly: true, fileMustExist: true });
    const extPath = reposExtendedDbPath(this.cfg.cacheDir, tag).replaceAll("'", "''");
    db.exec(`ATTACH DATABASE '${extPath}' AS ext`);
    try {
      // Read-heavy workload over a ~37 MB attached blob table: bigger page
      // cache, memory temp storage, and mmap keep repeated scans off the disk.
      db.pragma("cache_size = -32000");
      db.pragma("ext.cache_size = -32000");
      db.pragma("temp_store = MEMORY");
      db.pragma("mmap_size = 268435456");
      db.pragma("ext.mmap_size = 268435456");
      db.pragma("query_only = ON");
    } catch (err) {
      log.warn(`could not apply pragmas: ${(err as Error).message}`);
    }
    this.db = db;
    this.tag = tag;
    this.loadedAt = Date.now();
    this.releaseIndexPromise = null;
    this.imageIndexPromise = null;
    if (old) {
      // An index build may still be streaming rows from the old handle; closing
      // it underneath would abort that build, so wait for the ones in flight.
      const pending = [...this.buildsInFlight];
      const closeOld = (): void => {
        try { old.close(); } catch { /* ignore */ }
      };
      if (pending.length === 0) closeOld();
      else void Promise.allSettled(pending).then(closeOld);
    }
    this.warmIndexes();
  }

  /**
   * Build both indexes right after a load/swap so the first user query doesn't
   * pay for it. Errors are non-fatal — the next getter call retries.
   */
  private warmIndexes(): void {
    const report = (what: string) => (err: unknown) => {
      if (!this.closed) log.warn(`${what} index build failed: ${(err as Error).message}`);
    };
    void this.getReleaseIndex().catch(report("release"));
    void this.getImageIndex().catch(report("image"));
  }

  /** Memoize a build keyed on the connection it reads from. */
  private startBuild<T>(build: (db: Database.Database) => Promise<T>, clear: () => void): Promise<T> {
    const promise = build(this.require());
    this.buildsInFlight.add(promise);
    void promise.catch(() => {}).finally(() => this.buildsInFlight.delete(promise));
    void promise.catch(clear);
    return promise;
  }

  private require(): Database.Database {
    if (!this.db) throw new Error("DataStore not initialized — call ready() first");
    return this.db;
  }

  getReleaseIndex(): Promise<ReleaseIndex> {
    if (!this.releaseIndexPromise) {
      this.releaseIndexPromise = this.startBuild(buildReleaseIndex, () => { this.releaseIndexPromise = null; });
    }
    return this.releaseIndexPromise;
  }

  getImageIndex(): Promise<ImageIndex> {
    if (!this.imageIndexPromise) {
      this.imageIndexPromise = this.startBuild(buildImageIndex, () => { this.imageIndexPromise = null; });
    }
    return this.imageIndexPromise;
  }

  get database(): Database.Database {
    return this.require();
  }

  get currentTag(): string {
    return this.tag ?? "unknown";
  }

  /** Look up an indexed repo (e.g. "onedr0p/home-ops") to resolve its clone URL + branch. */
  getRepoByName(repoName: string): { url: string; branch: string | null } | null {
    const row = prepared(this.require(), "select url, branch from repo where repo_name = ?").get(repoName) as
      | { url: string | null; branch: string | null }
      | undefined;
    if (!row || !row.url) return null;
    return { url: row.url, branch: row.branch };
  }

  /** Fetch and parse `spec.values` JSON for a set of file URLs. */
  getValues(urls: string[]): Map<string, unknown> {
    const out = new Map<string, unknown>();
    if (urls.length === 0) return out;
    const placeholders = urls.map(() => "?").join(",");
    // The IN-filter lives in each arm (not wrapped around the UNION) so SQLite
    // is guaranteed to use the idx_*_url indexes instead of scanning both tables.
    const rows = prepared(
      this.require(),
      `select url, val from ext.flux_helm_release_values where url in (${placeholders})
       union all
       select url, val from ext.argo_helm_application_values where url in (${placeholders})`,
    ).all(...urls, ...urls) as Array<{ url: string; val: string | null }>;
    for (const row of rows) {
      if (!row.val) continue;
      try { out.set(row.url, JSON.parse(row.val)); } catch { /* skip malformed */ }
    }
    return out;
  }

  status(): DataStatus {
    const db = this.require();
    const count = (sql: string): number => (prepared(db, sql).get() as { c: number }).c;
    return {
      tag: this.currentTag,
      cacheDir: this.cfg.cacheDir,
      loadedAt: new Date(this.loadedAt).toISOString(),
      releaseFiles: count("select count(*) c from flux_helm_release"),
      reposIndexed: count("select count(*) c from repo"),
      helmReleases: count("select count(distinct chart_name) c from flux_helm_release"),
      ociRepositories: count("select count(*) c from flux_oci_repository"),
      valueDocuments: count("select count(*) c from ext.flux_helm_release_values"),
    };
  }

  close(): void {
    this.closed = true;
    this.releaseIndexPromise = null;
    this.imageIndexPromise = null;
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }
}
