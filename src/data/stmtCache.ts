import type { Database, Statement } from "better-sqlite3";

const caches = new WeakMap<Database, Map<string, Statement<unknown[], unknown>>>();

/**
 * Cache prepared statements per connection, so hot paths stop re-compiling the
 * same SQL. Keying on the Database instance makes a refresh swap safe by
 * construction: the new handle gets a fresh cache and the old map is collected
 * along with the closed connection.
 *
 * Only for statements consumed with .get()/.all(). A cached Statement must
 * never be re-entered while an earlier .iterate() over it is still open, so
 * streaming queries prepare their own.
 */
export function prepared(db: Database, sql: string): Statement<unknown[], unknown> {
  let cache = caches.get(db);
  if (!cache) {
    cache = new Map();
    caches.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}
