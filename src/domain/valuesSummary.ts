import { flatten } from "../util/jsonWalk.js";
import type { CommonSetting, Deployment, ValuesExample, ValuesSummary } from "./types.js";

/** Max deployments whose values are aggregated into a single summary. */
export const SUMMARY_CAP = 50;
/** Distinct values listed per common setting (the rest collapse into a count). */
const VALUES_PER_SETTING = 5;

/** Collapse array indices so `hostnames[0]`/`[1]` aggregate as `hostnames[]`. */
function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, "[]");
}

interface PathAgg {
  setBy: number;
  /** value → count across deployments that set this path. */
  values: Map<string, number>;
}

export interface SummarizeOptions {
  /** Number of common-setting paths to return (most-set first). */
  top: number;
  /** Number of full example configs to include (most-starred first). */
  examples: number;
}

/**
 * Aggregate how a chart is configured across its deployments: which value paths
 * are most commonly set, their typical values, and a few full examples.
 *
 * @param deployments Deployments for the chart, already sorted most-starred-first.
 * @param valuesByUrl Parsed `spec.values` keyed by deployment `fileUrl`.
 */
export function summarizeValues(
  deployments: Deployment[],
  valuesByUrl: Map<string, unknown>,
  opts: SummarizeOptions,
): ValuesSummary {
  // Aggregate over the most-starred deployments that actually have values.
  const withValues = deployments.filter((d) => valuesByUrl.has(d.fileUrl)).slice(0, SUMMARY_CAP);

  const agg = new Map<string, PathAgg>();
  for (const d of withValues) {
    const leaves = flatten(valuesByUrl.get(d.fileUrl));
    // De-dupe per deployment so one deployment counts once toward `setBy`,
    // even when a normalized path appears in several array elements.
    const seen = new Map<string, Set<string>>();
    for (const leaf of leaves) {
      const path = normalizePath(leaf.path);
      let valset = seen.get(path);
      if (!valset) { valset = new Set(); seen.set(path, valset); }
      valset.add(leaf.value);
    }
    for (const [path, values] of seen) {
      let entry = agg.get(path);
      if (!entry) { entry = { setBy: 0, values: new Map() }; agg.set(path, entry); }
      entry.setBy += 1;
      for (const v of values) entry.values.set(v, (entry.values.get(v) ?? 0) + 1);
    }
  }

  const analyzed = withValues.length;
  const commonSettings: CommonSetting[] = [...agg.entries()]
    .sort((a, b) => b[1].setBy - a[1].setBy || a[0].localeCompare(b[0]))
    .slice(0, opts.top)
    .map(([path, e]) => ({
      path,
      setBy: e.setBy,
      setPct: analyzed === 0 ? 0 : Math.round((e.setBy / analyzed) * 100),
      values: [...e.values.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, VALUES_PER_SETTING)
        .map(([value, count]) => ({ value, count })),
      distinctValues: e.values.size,
    }));

  const examples: ValuesExample[] = withValues.slice(0, opts.examples).map((d) => ({
    repo: d.repo,
    stars: d.stars,
    chartVersion: d.chartVersion,
    fileUrl: d.fileUrl,
    values: valuesByUrl.get(d.fileUrl),
  }));

  return { analyzedDeployments: analyzed, commonSettings, examples };
}
