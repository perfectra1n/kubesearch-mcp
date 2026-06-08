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

// SQLite LIKE is case-insensitive for ASCII; we use it as a (super)set filter
// and refine case-sensitivity in JS.
const GREP_QUERY = `
  select url, val from (
    select url, val from ext.flux_helm_release_values
    union all
    select url, val from ext.argo_helm_application_values
  )
  where val like ? escape '\\'
`;

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Grep across all values blobs for a substring, returning located snippets. */
export function grepValues(db: Database, index: ReleaseIndex, query: string, limit: number, caseSensitive: boolean): GrepResult {
  const rows = db.prepare(GREP_QUERY).all(`%${escapeLike(query)}%`) as Array<{ url: string; val: string | null }>;
  const q = caseSensitive ? query : query.toLowerCase();
  const matches: GrepMatch[] = [];
  let totalFiles = 0;

  for (const row of rows) {
    if (!row.val) continue;
    // Case-sensitive refinement: LIKE already matched case-insensitively.
    const hay = caseSensitive ? row.val : row.val.toLowerCase();
    if (!hay.includes(q)) continue;
    totalFiles++;
    if (matches.length >= limit) continue;

    let matchedKey: string | null = null;
    let snippet: string | null = null;
    try {
      const parsed = JSON.parse(row.val);
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
      snippet = makeSnippet(row.val, query, 60, caseSensitive) ?? row.val.slice(0, 140);
    }

    const meta = index.urlMeta.get(row.url);
    matches.push({
      fileUrl: row.url,
      repo: meta?.repo ?? null,
      chart: meta?.chart ?? null,
      stars: meta?.stars ?? null,
      matchedKey,
      snippet: snippet.length > 240 ? snippet.slice(0, 240) + "…" : snippet,
    });
  }

  matches.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));
  return { totalFiles, matches };
}
