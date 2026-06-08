/** Builders for canonical kubesearch.dev deep-links included in every result. */

const BASE = "https://kubesearch.dev";

export function helmReleaseSearchUrl(query: string): string {
  return `${BASE}/#${encodeURIComponent(query)}`;
}

export function helmReleaseDetailUrl(id: string): string {
  return `${BASE}/hr/${id}`;
}

export function imageSearchUrl(query: string): string {
  return `${BASE}/image#${encodeURIComponent(`image ${query}`)}`;
}

export function grepSearchUrl(query: string): string {
  return `${BASE}/grep#${encodeURIComponent(`grep ${query}`)}`;
}
