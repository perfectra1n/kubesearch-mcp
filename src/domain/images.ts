import { setImmediate as yieldToLoop } from "node:timers/promises";
import type { Database } from "better-sqlite3";
import { walkObjects } from "../util/jsonWalk.js";
import type { ImageEntry, ImageIndex, SearchEntry } from "./types.js";

/**
 * Rows processed between event-loop yields. Lower than the release index's
 * because every row here costs a JSON.parse of a full values document.
 */
const YIELD_EVERY = 200;

const VALUES_QUERY = `
  select url, val from ext.flux_helm_release_values
  union all
  select url, val from ext.argo_helm_application_values
`;

interface ImageAgg {
  tags: Set<string>;
  urls: Set<string>;
}

/** Parse "repo:tag" / "repo@sha256:..." image strings into {repository, tag}. */
function parseImageString(image: string): { repository: string; tag?: string } | null {
  if (!image || image.includes(" ")) return null;
  const withoutDigest = image.split("@")[0] ?? image;
  const lastColon = withoutDigest.lastIndexOf(":");
  const lastSlash = withoutDigest.lastIndexOf("/");
  if (lastColon > lastSlash) {
    return { repository: withoutDigest.slice(0, lastColon), tag: withoutDigest.slice(lastColon + 1) };
  }
  return { repository: withoutDigest };
}

function record(agg: Map<string, ImageAgg>, repository: string, tag: string | undefined, url: string): void {
  if (!repository) return;
  let entry = agg.get(repository);
  if (!entry) {
    entry = { tags: new Set(), urls: new Set() };
    agg.set(repository, entry);
  }
  if (tag) entry.tags.add(tag);
  entry.urls.add(url);
}

/**
 * Build a repository -> {tags, fileUrls} index by scanning every values blob in
 * the extended database. Mirrors kubesearch's image extraction but walks nested
 * objects too (so e.g. `controllers.main.containers.*.image` is captured).
 *
 * This is the most expensive operation in the server (a JSON.parse of the whole
 * ~37 MB corpus), so it streams and yields to the event loop rather than
 * blocking it for seconds.
 */
export async function buildImageIndex(db: Database): Promise<ImageIndex> {
  const rows = db.prepare(VALUES_QUERY).iterate() as Iterable<{ url: string; val: string | null }>;
  const agg = new Map<string, ImageAgg>();
  let processed = 0;

  for (const row of rows) {
    if (++processed % YIELD_EVERY === 0) await yieldToLoop();
    if (!row.val) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.val);
    } catch {
      continue;
    }
    walkObjects(parsed, (obj) => {
      // Case 1: { repository: "...", tag?: "..." }
      if (typeof obj.repository === "string") {
        const tag = typeof obj.tag === "string" || typeof obj.tag === "number" ? String(obj.tag) : undefined;
        record(agg, obj.repository, tag, row.url);
        return;
      }
      // Case 2: { image: "repo:tag" }
      if (typeof obj.image === "string") {
        const parsedImage = parseImageString(obj.image);
        if (parsedImage) record(agg, parsedImage.repository, parsedImage.tag, row.url);
      }
    });
  }

  const byRepo = new Map<string, ImageEntry>();
  for (const [repository, entry] of agg) {
    byRepo.set(repository, {
      repository,
      tags: [...entry.tags].sort(),
      usageCount: entry.urls.size,
      fileUrls: [...entry.urls],
    });
  }

  // Ranking is query-independent — sort once here, not on every search.
  const searchList: Array<SearchEntry<ImageEntry>> = [...byRepo.values()].map((item) => ({
    lower: item.repository.toLowerCase(),
    item,
  }));
  searchList.sort((a, b) => b.item.usageCount - a.item.usageCount || a.item.repository.localeCompare(b.item.repository));

  return { byRepo, searchList };
}

/** Search the image index by repository substring (case-insensitive). */
export function searchImages(
  index: ImageIndex,
  query: string,
  limit: number,
  offset: number,
): { total: number; entries: ImageEntry[] } {
  const q = query.toLowerCase();
  const matches = index.searchList.filter((e) => e.lower.includes(q));
  return { total: matches.length, entries: matches.slice(offset, offset + limit).map((e) => e.item) };
}
