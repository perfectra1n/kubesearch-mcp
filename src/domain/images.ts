import type { Database } from "better-sqlite3";
import { walkObjects } from "../util/jsonWalk.js";
import type { ImageEntry } from "./types.js";

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
 */
export function buildImageIndex(db: Database): Map<string, ImageEntry> {
  const rows = db.prepare(VALUES_QUERY).all() as Array<{ url: string; val: string | null }>;
  const agg = new Map<string, ImageAgg>();

  for (const row of rows) {
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

  const out = new Map<string, ImageEntry>();
  for (const [repository, entry] of agg) {
    out.set(repository, {
      repository,
      tags: [...entry.tags].sort(),
      usageCount: entry.urls.size,
      fileUrls: [...entry.urls],
    });
  }
  return out;
}

/** Search the image index by repository substring (case-insensitive). */
export function searchImages(index: Map<string, ImageEntry>, query: string, limit: number): { total: number; entries: ImageEntry[] } {
  const q = query.toLowerCase();
  const matches = [...index.values()].filter((e) => e.repository.toLowerCase().includes(q));
  matches.sort((a, b) => b.usageCount - a.usageCount || a.repository.localeCompare(b.repository));
  return { total: matches.length, entries: matches.slice(0, limit) };
}
