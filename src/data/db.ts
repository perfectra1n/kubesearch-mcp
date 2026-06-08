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
  writeMeta,
} from "./cache.js";
import { buildReleaseIndex } from "../domain/helmReleases.js";
import { buildImageIndex } from "../domain/images.js";
import type { ImageEntry, ReleaseIndex } from "../domain/types.js";

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
  private initPromise: Promise<void> | null = null;
  private refreshPromise: Promise<void> | null = null;
  private releaseIndex: ReleaseIndex | null = null;
  private imageIndex: Map<string, ImageEntry> | null = null;

  constructor(private readonly cfg: Config) {}

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
    const meta = readMeta(cacheDir);

    const cacheStillFresh = !this.cfg.autoRefresh || Date.now() - (meta?.fetchedAt ?? 0) < refreshTtlMs;
    if (meta && filesExist(cacheDir, meta.tag) && cacheStillFresh) {
      log(`using cached databases (tag ${meta.tag})`);
      this.open(meta.tag);
      this.lastCheckedAt = Date.now();
      return;
    }

    let latest: string;
    try {
      latest = await resolveLatestTag(upstreamRepo, githubToken);
    } catch (err) {
      if (meta && filesExist(cacheDir, meta.tag)) {
        log(`release check failed (${(err as Error).message}); serving cached tag ${meta.tag}`);
        this.open(meta.tag);
        this.lastCheckedAt = Date.now();
        return;
      }
      throw err;
    }

    if (!filesExist(cacheDir, latest)) {
      log(`fetching databases for release ${latest}…`);
      await downloadDatabases(upstreamRepo, latest, cacheDir);
    }
    await writeMeta(cacheDir, { tag: latest, fetchedAt: Date.now() });
    await pruneOldTags(cacheDir, latest);
    this.open(latest);
    this.lastCheckedAt = Date.now();
  }

  private maybeRefresh(): Promise<void> {
    if (!this.cfg.autoRefresh) return Promise.resolve();
    if (this.refreshPromise) return this.refreshPromise;
    if (Date.now() - this.lastCheckedAt < this.cfg.refreshTtlMs) return Promise.resolve();
    return this.runRefresh();
  }

  private runRefresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    this.lastCheckedAt = Date.now();
    this.refreshPromise = this.refresh()
      .catch((err) => log(`background refresh failed: ${(err as Error).message}`))
      .finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  /**
   * Start a proactive timer that checks for a newer release every `refreshTtlMs`,
   * independent of incoming requests (important for a long-running HTTP deploy).
   * Returns a stop function. No-op when auto-refresh is disabled.
   */
  startAutoRefresh(): () => void {
    if (!this.cfg.autoRefresh) return () => {};
    const timer = setInterval(() => {
      if (this.db) void this.runRefresh();
    }, this.cfg.refreshTtlMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async refresh(): Promise<void> {
    const { cacheDir, upstreamRepo, githubToken } = this.cfg;
    const latest = await resolveLatestTag(upstreamRepo, githubToken);
    if (latest === this.tag) return;
    log(`newer release available (${latest}); downloading…`);
    await downloadDatabases(upstreamRepo, latest, cacheDir);
    await writeMeta(cacheDir, { tag: latest, fetchedAt: Date.now() });
    this.open(latest);
    await pruneOldTags(cacheDir, latest);
    log(`swapped to release ${latest}`);
  }

  private open(tag: string): void {
    const old = this.db;
    const db = new Database(reposDbPath(this.cfg.cacheDir, tag), { readonly: true, fileMustExist: true });
    const extPath = reposExtendedDbPath(this.cfg.cacheDir, tag).replaceAll("'", "''");
    db.exec(`ATTACH DATABASE '${extPath}' AS ext`);
    this.db = db;
    this.tag = tag;
    this.loadedAt = Date.now();
    this.releaseIndex = null;
    this.imageIndex = null;
    if (old) {
      try { old.close(); } catch { /* ignore */ }
    }
  }

  private require(): Database.Database {
    if (!this.db) throw new Error("DataStore not initialized — call ready() first");
    return this.db;
  }

  getReleaseIndex(): ReleaseIndex {
    if (!this.releaseIndex) this.releaseIndex = buildReleaseIndex(this.require());
    return this.releaseIndex;
  }

  getImageIndex(): Map<string, ImageEntry> {
    if (!this.imageIndex) this.imageIndex = buildImageIndex(this.require());
    return this.imageIndex;
  }

  get database(): Database.Database {
    return this.require();
  }

  get currentTag(): string {
    return this.tag ?? "unknown";
  }

  /** Fetch and parse `spec.values` JSON for a set of file URLs. */
  getValues(urls: string[]): Map<string, unknown> {
    const out = new Map<string, unknown>();
    if (urls.length === 0) return out;
    const placeholders = urls.map(() => "?").join(",");
    const rows = this.require()
      .prepare(
        `select url, val from (
           select url, val from ext.flux_helm_release_values
           union all
           select url, val from ext.argo_helm_application_values
         ) where url in (${placeholders})`,
      )
      .all(...urls) as Array<{ url: string; val: string | null }>;
    for (const row of rows) {
      if (!row.val) continue;
      try { out.set(row.url, JSON.parse(row.val)); } catch { /* skip malformed */ }
    }
    return out;
  }

  status(): DataStatus {
    const db = this.require();
    const count = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
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
    if (this.db) {
      try { this.db.close(); } catch { /* ignore */ }
      this.db = null;
    }
  }
}
