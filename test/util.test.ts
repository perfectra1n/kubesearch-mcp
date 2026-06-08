import { describe, expect, it } from "vitest";
import { flatten, projectPaths, walkObjects } from "../src/util/jsonWalk.js";
import { makeSnippet } from "../src/util/snippet.js";
import { grepSearchUrl, imageSearchUrl } from "../src/util/links.js";

describe("flatten", () => {
  it("produces dotted/bracketed leaf paths", () => {
    const leaves = flatten({ a: { b: 1 }, c: ["x", "y"] });
    expect(leaves).toEqual([
      { path: "a.b", value: "1" },
      { path: "c[0]", value: "x" },
      { path: "c[1]", value: "y" },
    ]);
  });
});

describe("walkObjects", () => {
  it("visits nested objects, including those inside arrays", () => {
    const seen: string[] = [];
    walkObjects({ image: { repository: "r" }, list: [{ repository: "r2" }] }, (o) => {
      if (typeof o.repository === "string") seen.push(o.repository);
    });
    expect(seen.sort()).toEqual(["r", "r2"]);
  });
});

describe("projectPaths", () => {
  const obj = {
    server: { persistentVolume: { size: "20Gi", enabled: true }, retentionPeriod: "14d" },
    dashboards: { enabled: true },
  };

  it("keeps the whole subtree at a requested path", () => {
    expect(projectPaths(obj, ["server.persistentVolume"])).toEqual({
      server: { persistentVolume: { size: "20Gi", enabled: true } },
    });
  });

  it("prunes siblings while keeping the requested leaf", () => {
    expect(projectPaths(obj, ["server.retentionPeriod"])).toEqual({
      server: { retentionPeriod: "14d" },
    });
  });

  it("supports multiple paths across branches", () => {
    expect(projectPaths(obj, ["server.retentionPeriod", "dashboards"])).toEqual({
      server: { retentionPeriod: "14d" },
      dashboards: { enabled: true },
    });
  });

  it("keeps an ancestor key whole", () => {
    expect(projectPaths(obj, ["server"])).toEqual({ server: obj.server });
  });

  it("returns {} for a missing path or empty input", () => {
    expect(projectPaths(obj, ["nope.nothing"])).toEqual({});
    expect(projectPaths(obj, [])).toEqual({});
    expect(projectPaths(null, ["server"])).toEqual({});
  });
});

describe("makeSnippet", () => {
  it("centers on the match with ellipses", () => {
    const snip = makeSnippet("the quick brown fox jumps over the lazy dog", "fox", 5);
    expect(snip).not.toBeNull();
    expect(snip!).toContain("fox");
    expect(snip!.startsWith("…")).toBe(true);
  });
  it("returns null when not found", () => {
    expect(makeSnippet("abc", "xyz")).toBeNull();
  });
});

describe("links", () => {
  it("builds the grep + image deep links like the site", () => {
    expect(grepSearchUrl("cert-manager.io")).toBe("https://kubesearch.dev/grep#grep%20cert-manager.io");
    expect(imageSearchUrl("cert-manager")).toBe("https://kubesearch.dev/image#image%20cert-manager");
  });
});
