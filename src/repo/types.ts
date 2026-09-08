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
  /** Pool member: exempt from the idle TTL, the LRU cap, `repo_cleanup`, and shutdown cleanup. */
  pinned?: boolean;
  /** Repo stars from the index (pool members only; drives grep_all ordering). */
  stars?: number;
}

/** What the pool needs to say to register an always-warm clone. */
export interface PinSpec {
  /** Stable handle; for pool members this is the indexed repo name. */
  handle: string;
  source: string;
  url: string;
  /** Indexed branch, or null to take the remote default. */
  branch: string | null;
  dir: string;
  stars: number;
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
  /** True for an always-warm pool clone (never expires; expires_in_minutes is 0). */
  pinned: boolean;
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

export interface RepoGrepAllOptions {
  glob?: string;
  caseSensitive?: boolean;
  /** Max lines returned per repo (counts stay complete). */
  maxPerRepo?: number;
  /** Max lines returned across all repos. */
  limit?: number;
}

export interface RepoGrepAllRepo {
  /** Pass to repo_read_file / repo_list_files / repo_grep to follow up. */
  handle: string;
  repo: string;
  stars: number;
  branch: string;
  match_count: number;
  matches: RepoGrepMatch[];
  truncated: boolean;
}

export interface RepoGrepAllResult {
  query: string;
  repos_searched: number;
  total_matches: number;
  /** Only repos with at least one hit, most-starred first. */
  repos: RepoGrepAllRepo[];
  truncated: boolean;
}
