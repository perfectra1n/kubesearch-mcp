export interface CloneRecord {
  handle: string;
  /** Dedupe key (resolved url + requested branch). */
  key: string;
  dir: string;
  /** The resolved https URL that was cloned. */
  url: string;
  /** The original input the caller provided (owner/repo or URL). */
  source: string;
  branch: string;
  createdAt: number;
  lastUsed: number;
  sizeBytes: number;
  fileCount: number;
}

export interface CloneResult {
  handle: string;
  resolved_url: string;
  branch: string;
  file_count: number;
  size_mb: number;
  expires_in_minutes: number;
  /** True when this reused an existing clone that was refreshed (git fetch) rather than freshly cloned. */
  reused: boolean;
  updated: boolean;
  /** Curated listing biased toward Kubernetes/Flux/Helm files. */
  tree: string[];
}

export interface RepoFileListing {
  handle: string;
  path: string;
  entries: Array<{ path: string; type: "file" | "dir"; size?: number }>;
  truncated: boolean;
}

export interface RepoFileContent {
  handle: string;
  path: string;
  content: string;
  bytes: number;
  truncated: boolean;
}

export interface RepoGrepMatch {
  path: string;
  line: number;
  text: string;
}

export interface RepoGrepResult {
  handle: string;
  query: string;
  total_matches: number;
  matches: RepoGrepMatch[];
  truncated: boolean;
}
