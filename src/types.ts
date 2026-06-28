export interface RepoEntry {
  name: string;
  url: string;
  path: string;    // relative path from workspace root where repo is cloned
  ref: string;     // branch/tag/sha to track
}

export interface WorkspaceManifest {
  name: string;
  repos: RepoEntry[];
}

export interface LockRepo {
  url: string;
  ref: string;
  commit: string;  // full SHA
}

export interface Lockfile {
  version: 1;
  repos: Record<string, LockRepo>;  // keyed by repo name
  hash: string;                     // sha256 hex of sorted "name:commit" lines
}
