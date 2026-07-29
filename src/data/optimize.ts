import Database from "better-sqlite3";
import { reposExtendedDbPath } from "./cache.js";
import { log } from "../util/log.js";

/**
 * Add lookup indexes to the downloaded extended database so per-release value
 * fetches are seeks instead of full scans of the ~37 MB corpus. Idempotent and
 * cheap when the indexes already exist, so it runs on every load path —
 * previously-downloaded caches get upgraded in place. Failures are non-fatal:
 * the indexes are an optimization, not a correctness requirement.
 */
export function optimizeDatabases(cacheDir: string, tag: string): void {
  const path = reposExtendedDbPath(cacheDir, tag);
  let db: Database.Database;
  try {
    db = new Database(path, { fileMustExist: true });
  } catch (err) {
    log.warn(`could not open ${path} for optimization: ${(err as Error).message}`);
    return;
  }
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fhrv_url ON flux_helm_release_values(url);
      CREATE INDEX IF NOT EXISTS idx_ahav_url ON argo_helm_application_values(url);
    `);
  } catch (err) {
    log.warn(`could not add lookup indexes to ${path}: ${(err as Error).message}`);
  } finally {
    db.close();
  }
}
