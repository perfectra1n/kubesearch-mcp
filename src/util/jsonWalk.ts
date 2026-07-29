/** Helpers for walking parsed `spec.values` JSON. */

export interface Leaf {
  /** Dot/bracket path to the leaf, e.g. `controller.image.repository` or `args[0]`. */
  path: string;
  /** Stringified primitive value. */
  value: string;
}

/** Recursively flatten an object/array into primitive leaves with their paths. */
export function flatten(node: unknown, prefix = "", out: Leaf[] = []): Leaf[] {
  if (node === null || node === undefined) {
    return out;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => flatten(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof node === "object") {
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      flatten(value, path, out);
    }
    return out;
  }
  out.push({ path: prefix, value: String(node) });
  return out;
}

/** Visit every object node in the tree (depth-first), invoking `cb` on each. */
export function walkObjects(node: unknown, cb: (obj: Record<string, unknown>) => void): void {
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) walkObjects(item, cb);
    return;
  }
  const obj = node as Record<string, unknown>;
  cb(obj);
  for (const value of Object.values(obj)) walkObjects(value, cb);
}

/**
 * Prune `obj` to only the subtrees whose dotted key path matches one of `paths`.
 * A path matches when it equals, is a prefix of, or is a descendant of a
 * requested path (so `server.persistentVolume` keeps the whole subtree, and
 * `server` keeps everything under `server`). Arrays are kept whole when their
 * containing key is selected. Returns a new object; `{}` when nothing matches.
 *
 * Array subscripts in the requested paths are ignored, so the `hostnames[]`
 * form printed by the summary view's `common_settings` (and the `hosts[0]` form
 * from a raw leaf path) can be pasted straight back in as a `value_paths` entry.
 */
export function projectPaths(obj: unknown, paths: string[]): Record<string, unknown> {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return {};
  const wanted = paths.map((p) => p.replace(/\[\d*\]/g, "")).filter((p) => p.length > 0);
  if (wanted.length === 0) return {};

  const pick = (node: Record<string, unknown>, prefix: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      const path = prefix === "" ? key : `${prefix}.${key}`;
      // At or below a requested path → keep the whole value.
      const inSelection = wanted.some((w) => path === w || path.startsWith(`${w}.`));
      // Strict ancestor of a requested path → recurse to find the descendant.
      const isAncestor = wanted.some((w) => w.startsWith(`${path}.`));
      if (inSelection) {
        out[key] = value;
      } else if (isAncestor && value !== null && typeof value === "object" && !Array.isArray(value)) {
        const child = pick(value as Record<string, unknown>, path);
        if (Object.keys(child).length > 0) out[key] = child;
      }
    }
    return out;
  };

  return pick(obj as Record<string, unknown>, "");
}
