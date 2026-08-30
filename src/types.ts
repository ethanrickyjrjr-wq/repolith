export interface RepoEntry {
  name: string;
  url: string;
  path: string;    // relative path from workspace root where repo is cloned
  ref: string;     // branch/tag/sha to track
}

export interface CoordConfig {
  // Basenames (e.g. "SESSION_LOG.md") exempt from the edit-gate claim/deny — independent
  // appends to a shared log don't conflict, so gating them just starves whoever loses the
  // race. Merged with the built-in default list, not a replacement for it.
  append_only?: string[];
  // Workspace-relative globs whose Write/Edit registers the session's plan scope
  // (the spec-file → plan-store bridge). Absent → DEFAULT_SPEC_PATTERNS (commands/spec.ts).
  spec_patterns?: string[];
}

export interface WorkspaceManifest {
  name: string;
  repos: RepoEntry[];
  coord?: CoordConfig;
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
