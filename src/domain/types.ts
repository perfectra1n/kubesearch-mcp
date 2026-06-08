/** A single HelmRelease/Application deployment found in one repo's YAML. */
export interface Deployment {
  key: string;
  chart: string;
  release: string;
  namespace: string | null;
  chartVersion: string | null;
  chartSourceUrl: string;
  helmRepoName: string;
  repo: string;
  repoUrl: string | null;
  stars: number;
  fileUrl: string;
  timestamp: string;
  icon: string | null;
  group: string | null;
}

/** All deployments that share a release key (one `/hr/<id>` page). */
export interface ReleaseGroup {
  id: string;
  chart: string;
  chartSourceUrl: string;
  deploymentCount: number;
  deployments: Deployment[];
}

/** Lightweight per-file metadata, keyed by the YAML file URL. */
export interface UrlMeta {
  repo: string;
  chart: string;
  stars: number;
  key: string;
}

export interface ReleaseIndex {
  groups: Map<string, ReleaseGroup>;
  urlMeta: Map<string, UrlMeta>;
}

export interface ImageEntry {
  repository: string;
  tags: string[];
  usageCount: number;
  fileUrls: string[];
}

/** One frequently-set value path across a chart's deployments. */
export interface CommonSetting {
  /** Key path with array indices collapsed, e.g. `server.route.hostnames[]`. */
  path: string;
  /** How many analyzed deployments set this path. */
  setBy: number;
  /** `setBy` as a percentage of analyzed deployments (rounded integer). */
  setPct: number;
  /** Most common distinct values, with their counts (capped). */
  values: Array<{ value: string; count: number }>;
  /** Total number of distinct values seen for this path. */
  distinctValues: number;
}

/** One real-world example configuration for a chart. */
export interface ValuesExample {
  repo: string;
  stars: number;
  chartVersion: string | null;
  fileUrl: string;
  values: unknown;
}

/** Aggregated view of how a chart is configured across its deployments. */
export interface ValuesSummary {
  analyzedDeployments: number;
  commonSettings: CommonSetting[];
  examples: ValuesExample[];
}
