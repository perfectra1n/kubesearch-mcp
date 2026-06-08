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
