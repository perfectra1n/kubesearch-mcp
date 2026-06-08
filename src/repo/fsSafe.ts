import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export class PathEscapeError extends Error {}

const WALK_MAX_FILES = 20000;
const TREE_MAX = 60;
const INTERESTING_RE = /(helmrelease|kustomization|values|chart\.ya?ml|\.ya?ml$|\.tf$|\.tpl$|dockerfile|readme)/i;

/**
 * Resolve `rel` inside `baseDir`, rejecting any path that escapes the sandbox
 * via `..` or a symlink. Returns the real absolute path.
 */
export function resolveInside(baseDir: string, rel: string): string {
  const base = fs.realpathSync(baseDir);
  const target = path.resolve(base, rel ?? ".");
  let real: string;
  try {
    real = fs.realpathSync(target);
  } catch {
    real = target; // non-existent path: validate its resolved form
  }
  if (real !== base && !real.startsWith(base + path.sep)) {
    throw new PathEscapeError(`Path escapes the repository sandbox: ${rel}`);
  }
  return real;
}

/** Recursively collect file paths (relative to root) + total size, never following symlinks. */
export async function walkFiles(root: string): Promise<{ files: string[]; size: number }> {
  const files: string[] = [];
  let size = 0;
  const walk = async (absDir: string): Promise<void> => {
    if (files.length >= WALK_MAX_FILES) return;
    let dirents: fs.Dirent[];
    try {
      dirents = await fsp.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      if (d.name === ".git" || d.isSymbolicLink()) continue; // never follow symlinks
      const abs = path.join(absDir, d.name);
      if (d.isDirectory()) {
        await walk(abs);
      } else if (d.isFile()) {
        files.push(path.relative(root, abs));
        try {
          size += (await fsp.stat(abs)).size;
        } catch {
          /* ignore */
        }
        if (files.length >= WALK_MAX_FILES) return;
      }
    }
  };
  await walk(root);
  return { files, size };
}

/** A curated, capped file list biased toward Kubernetes/Flux/Helm files. */
export function curatedTree(files: string[]): string[] {
  const ranked = [...files].sort((a, b) => {
    const score = (f: string) => (INTERESTING_RE.test(f) ? 0 : 1) + f.split("/").length * 0.01;
    return score(a) - score(b) || a.localeCompare(b);
  });
  return ranked.slice(0, TREE_MAX);
}

/**
 * Minimal glob to RegExp. Supports `*` (within a path segment), `?`, double-star
 * (across segments), and a leading double-star segment that matches zero or more
 * directories. Anchored to the full relative path.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?"; // **/ matches zero or more directories
        i += 3;
      } else {
        re += ".*";
        i += 2;
      }
    } else if (c === "*") {
      re += "[^/]*";
      i += 1;
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if ("\\^$+.()|{}[]".includes(c)) {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  return new RegExp(re + "$", "i");
}
