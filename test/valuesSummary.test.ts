import { describe, expect, it } from "vitest";
import { summarizeValues, SUMMARY_CAP } from "../src/domain/valuesSummary.js";
import type { Deployment } from "../src/domain/types.js";

/** Build a minimal Deployment; only the fields the summary reads matter. */
function dep(repo: string, stars: number, fileUrl: string, chartVersion: string | null = "1.0.0"): Deployment {
  return {
    key: repo,
    chart: "victoria-logs-single",
    release: "victoria-logs",
    namespace: null,
    chartVersion,
    chartSourceUrl: "oci://example/chart",
    helmRepoName: "vm",
    repo,
    repoUrl: `https://github.com/${repo}`,
    stars,
    fileUrl,
    timestamp: "1700000000",
    icon: null,
    group: null,
  };
}

describe("summarizeValues", () => {
  const deployments = [
    dep("a/ops", 900, "u1"),
    dep("b/ops", 800, "u2"),
    dep("c/ops", 700, "u3"),
  ];
  const valuesByUrl = new Map<string, unknown>([
    ["u1", { server: { persistentVolume: { size: "20Gi" }, retentionPeriod: "14d" }, dashboards: { enabled: true } }],
    ["u2", { server: { persistentVolume: { size: "20Gi" }, retentionPeriod: "90d" }, dashboards: { enabled: true } }],
    ["u3", { server: { persistentVolume: { size: "50Gi" }, retentionPeriod: "14d" } }],
  ]);

  it("counts how many deployments set each path (set_by / set_pct)", () => {
    const s = summarizeValues(deployments, valuesByUrl, { top: 25, examples: 0 });
    expect(s.analyzedDeployments).toBe(3);
    const retention = s.commonSettings.find((c) => c.path === "server.retentionPeriod")!;
    expect(retention.setBy).toBe(3);
    expect(retention.setPct).toBe(100);
    const dashboards = s.commonSettings.find((c) => c.path === "dashboards.enabled")!;
    expect(dashboards.setBy).toBe(2);
    expect(dashboards.setPct).toBe(67);
  });

  it("tallies distinct values, most common first", () => {
    const s = summarizeValues(deployments, valuesByUrl, { top: 25, examples: 0 });
    const retention = s.commonSettings.find((c) => c.path === "server.retentionPeriod")!;
    expect(retention.distinctValues).toBe(2);
    expect(retention.values[0]).toEqual({ value: "14d", count: 2 });
    expect(retention.values[1]).toEqual({ value: "90d", count: 1 });
  });

  it("collapses array indices so per-element paths aggregate", () => {
    const deps = [dep("a/ops", 9, "x1"), dep("b/ops", 8, "x2")];
    const vals = new Map<string, unknown>([
      ["x1", { route: { hostnames: ["a.example", "b.example"] } }],
      ["x2", { route: { hostnames: ["c.example"] } }],
    ]);
    const s = summarizeValues(deps, vals, { top: 25, examples: 0 });
    const hostnames = s.commonSettings.find((c) => c.path === "route.hostnames[]");
    expect(hostnames).toBeDefined();
    expect(hostnames!.setBy).toBe(2); // both deployments, counted once each
    expect(hostnames!.distinctValues).toBe(3); // a/b/c across both
  });

  it("returns the most-starred deployments as examples", () => {
    const s = summarizeValues(deployments, valuesByUrl, { top: 25, examples: 2 });
    expect(s.examples).toHaveLength(2);
    expect(s.examples[0]!.repo).toBe("a/ops");
    expect(s.examples[0]!.values).toEqual(valuesByUrl.get("u1"));
  });

  it("respects the `top` cap on common settings", () => {
    const s = summarizeValues(deployments, valuesByUrl, { top: 1, examples: 0 });
    expect(s.commonSettings).toHaveLength(1);
  });

  it("ignores deployments without parsed values", () => {
    const deps = [dep("a/ops", 9, "has"), dep("b/ops", 8, "missing")];
    const vals = new Map<string, unknown>([["has", { installCRDs: true }]]);
    const s = summarizeValues(deps, vals, { top: 25, examples: 1 });
    expect(s.analyzedDeployments).toBe(1);
    expect(s.commonSettings[0]!.setPct).toBe(100);
  });

  it("aggregates at most SUMMARY_CAP deployments", () => {
    const many = Array.from({ length: SUMMARY_CAP + 10 }, (_, i) => dep(`r${i}/ops`, 1000 - i, `u${i}`));
    const vals = new Map<string, unknown>(many.map((d) => [d.fileUrl, { installCRDs: true }]));
    const s = summarizeValues(many, vals, { top: 25, examples: 0 });
    expect(s.analyzedDeployments).toBe(SUMMARY_CAP);
  });
});
