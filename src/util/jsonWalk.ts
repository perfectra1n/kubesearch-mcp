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
