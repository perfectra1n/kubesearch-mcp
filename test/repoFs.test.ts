import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { curatedTree, globToRegExp, PathEscapeError, resolveInside, walkFiles } from "../src/repo/fsSafe.js";

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kubesearch-repofs-"));
  fs.mkdirSync(path.join(dir, "kubernetes", "apps"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(dir, "kubernetes", "apps", "helmrelease.yaml"), "spec:\n  chart: cert-manager\n");
  fs.writeFileSync(path.join(dir, "notes.txt"), "hello world\n");
  // a secret outside the sandbox + a symlink pointing at it
  fs.writeFileSync(path.join(os.tmpdir(), "kubesearch-secret.txt"), "TOPSECRET\n");
  try {
    fs.symlinkSync(path.join(os.tmpdir(), "kubesearch-secret.txt"), path.join(dir, "escape-link"));
  } catch {
    /* symlink may be unavailable on some platforms */
  }
});

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("resolveInside", () => {
  it("resolves a normal in-sandbox path", () => {
    const p = resolveInside(dir, "kubernetes/apps/helmrelease.yaml");
    expect(p.endsWith(path.join("kubernetes", "apps", "helmrelease.yaml"))).toBe(true);
  });

  it("rejects ../ traversal", () => {
    expect(() => resolveInside(dir, "../kubesearch-secret.txt")).toThrow(PathEscapeError);
    expect(() => resolveInside(dir, "../../etc/passwd")).toThrow(PathEscapeError);
  });

  it("rejects symlink escape", () => {
    if (fs.existsSync(path.join(dir, "escape-link"))) {
      expect(() => resolveInside(dir, "escape-link")).toThrow(PathEscapeError);
    }
  });
});

describe("walkFiles", () => {
  it("lists files, skipping symlinks", async () => {
    const { files } = await walkFiles(dir);
    expect(files).toContain("README.md");
    expect(files.some((f) => f.endsWith("helmrelease.yaml"))).toBe(true);
    expect(files).not.toContain("escape-link"); // symlinks are not followed/listed
  });
});

describe("curatedTree", () => {
  it("ranks Kubernetes/Helm files first", () => {
    const tree = curatedTree(["random.bin", "kubernetes/apps/helmrelease.yaml", "README.md"]);
    expect(tree[0]).toMatch(/helmrelease|readme/i);
  });
});

describe("globToRegExp", () => {
  it("matches ** across slashes and * within a segment", () => {
    expect(globToRegExp("**/*.yaml").test("kubernetes/apps/helmrelease.yaml")).toBe(true);
    expect(globToRegExp("*.yaml").test("helmrelease.yaml")).toBe(true);
    expect(globToRegExp("*.yaml").test("a/b.yaml")).toBe(false);
  });
});
