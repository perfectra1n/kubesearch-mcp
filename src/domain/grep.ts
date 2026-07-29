import type { Database } from "better-sqlite3";
import { flatten } from "../util/jsonWalk.js";
import { makeSnippet } from "../util/snippet.js";
import type { ReleaseIndex } from "./types.js";

export interface GrepMatch {
  fileUrl: string;
  repo: string | null;
  chart: string | null;
  stars: number | null;
  matchedKey: string | null;
  snippet: string;
}

export interface GrepResult {
  totalFiles: number;
  matches: GrepMatch[];
}

// Pass 1 filters in SQLite and streams the result. The url-only variant is the
// common path: SQLite's LIKE already folds ASCII case, so an ASCII
// case-insensitive query needs no JS refinement — and skipping `val` keeps the
// entire ~37 MB values corpus out of the JS heap.
const MATCH_URLS_QUERY = `
  select url from ext.flux_helm_release_values where val like ? escape '\\'
  union all
  select url from ext.argo_helm_application_values where val like ? escape '\\'
`;

// Used only when JS must re-check the match (case-sensitive, or a non-ASCII
// query where SQLite's ASCII-only case folding is not enough).
const MATCH_ROWS_QUERY = `
  select url, val from ext.flux_helm_release_values where val like ? escape '\\'
  union all
  select url, val from ext.argo_helm_application_values where val like ? escape '\\'
`;

// Pass 2 fetches only the page's blobs, seeking via the idx_*_url indexes.
function pageValuesQuery(count: number): string {
  const placeholders = Array.from({ length: count }, () => "?").join(",");
  return `
    select url, val from ext.flux_helm_release_values where url in (${placeholders})
    union all
    select url, val from ext.argo_helm_application_values where url in (${placeholders})
  `;
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * Grep across all values blobs for a substring, returning located snippets.
 *
 * Runs in two passes so that neither the corpus nor the ranking depends on how
 * many results the caller wants: pass 1 streams every matching row to count and
 * rank them, pass 2 parses only the requested page.
 */
export function grepValues(
  db: Database,
  index: ReleaseIndex,
  query: string,
  limit: number,
  caseSensitive: boolean,
  offset = 0,
): GrepResult {
  const like = `%${escapeLike(query)}%`;
  const needsRefine = caseSensitive || !ASCII_ONLY.test(query);
  const q = caseSensitive ? query : query.toLowerCase();

  const refs: Array<{ url: string; stars: number }> = [];
  if (needsRefine) {
    const rows = db.prepare(MATCH_ROWS_QUERY).iterate(like, like) as Iterable<{ url: string; val: string | null }>;
    for (const row of rows) {
      if (!row.val) continue;
      const hay = caseSensitive ? row.val : row.val.toLowerCase();
      if (!hay.includes(q)) continue;
      refs.push({ url: row.url, stars: index.urlMeta.get(row.url)?.stars ?? 0 });
    }
  } else {
    const rows = db.prepare(MATCH_URLS_QUERY).iterate(like, like) as Iterable<{ url: string }>;
    for (const row of rows) {
      refs.push({ url: row.url, stars: index.urlMeta.get(row.url)?.stars ?? 0 });
    }
  }

  const totalFiles = refs.length;
  // Rank the whole set before paging, and break star ties on url so successive
  // pages never overlap or skip.
  refs.sort((a, b) => b.stars - a.stars || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  const page = refs.slice(offset, offset + limit);
  if (page.length === 0) return { totalFiles, matches: [] };

  const urls = page.map((r) => r.url);
  const rows = db.prepare(pageValuesQuery(urls.length)).all(...urls, ...urls) as Array<{
    url: string;
    val: string | null;
  }>;
  const valByUrl = new Map<string, string>();
  for (const row of rows) if (row.val) valByUrl.set(row.url, row.val);

  const matches: GrepMatch[] = [];
  for (const ref of page) {
    const val = valByUrl.get(ref.url);
    if (val === undefined) continue;

    let matchedKey: string | null = null;
    let snippet: string | null = null;
    try {
      const parsed = JSON.parse(val);
      for (const leaf of flatten(parsed)) {
        const path = caseSensitive ? leaf.path : leaf.path.toLowerCase();
        const value = caseSensitive ? leaf.value : leaf.value.toLowerCase();
        if (path.includes(q) || value.includes(q)) {
          matchedKey = leaf.path;
          snippet = `${leaf.path} = ${leaf.value}`;
          break;
        }
      }
    } catch {
      /* fall through to raw snippet */
    }
    if (snippet === null) {
      snippet = makeSnippet(val, query, 60, caseSensitive) ?? val.slice(0, 140);
    }

    const meta = index.urlMeta.get(ref.url);
    matches.push({
      fileUrl: ref.url,
      repo: meta?.repo ?? null,
      chart: meta?.chart ?? null,
      stars: meta?.stars ?? null,
      matchedKey,
      snippet: snippet.length > 240 ? snippet.slice(0, 240) + "…" : snippet,
    });
  }

  return { totalFiles, matches };
}
