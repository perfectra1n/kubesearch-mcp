/** Extract a bounded snippet of `text` centered on the first match of `term`. */
export function makeSnippet(text: string, term: string, radius = 60, caseSensitive = false): string | null {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? term : term.toLowerCase();
  const idx = haystack.indexOf(needle);
  if (idx === -1) return null;
  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + term.length + radius);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return prefix + text.slice(start, end).replace(/\s+/g, " ").trim() + suffix;
}
