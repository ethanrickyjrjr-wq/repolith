// Stale-claim detection — is a held claim still protecting live, uncommitted work?
//
// Incident that forced this (08/12/2026, brain-platform): `_ASSISTANT/STRIKES.md` was held by
// a session that had ALREADY COMMITTED its edit (`b2edd782`) and moved on — the file sat clean
// for 24+ minutes while the claim kept denying every other session. `claim wait` twice exited 0
// without ever granting the claim, and `claim waits` reported nobody queued. The only way anyone
// found out the claim was safe to clear was by hand: `git status` (clean), `git log -1` (the
// holder's own commit already landed), `claim waits` (nothing genuinely queued). This module is
// that manual test, automated — see docs/handoff/2026-08-12-open-house-decisions-owed-work-and-
// the-tracking-finding.md and _ASSISTANT/STRIKES.md ("stale-claim-blocks-work-and-the-wait-
// does-not-detect-it") in brain-platform for the full writeup.
//
// Two signals, never a guess from claim age alone, and NEVER fired against a dirty file — that
// would be exactly the clobber the claim registry exists to prevent:
//
//   - `clean-since-commit` — the file has no uncommitted diff AND its last commit landed at or
//     after the claim's own `claimed_at`. The holder's edit already shipped. Auto-release grade:
//     there is nothing left under this claim to protect.
//   - `idle-clean` — the file is clean and has stayed clean for the claim's entire life (no
//     commit landed after `claimed_at`, or the file has no commits at all) for at least
//     `idleGraceMs`. Nothing was ever dirtied under this claim. Flag grade, not auto-release
//     grade: it could just be a claim taken a moment before the first real edit, so it needs the
//     grace window and stays a flag rather than an automatic release.
//
// `gitFileState` returning null (file outside every manifest repo, git error, repo not yet
// cloned) is "cannot assess" — callers must treat that as not-stale, never as evidence.

import { join } from 'node:path';
import { execa } from 'execa';
import type { WorkspaceManifest } from '../types.js';
import type { Claim } from './claims.js';
import { gitRun } from '../git.js';

export interface GitFileState {
  clean: boolean;
  lastCommitAt: string | null; // ISO 8601 (git %cI), or null if the file has no commits
}

export type GitFileStateFn = (root: string, manifest: WorkspaceManifest, file: string) => Promise<GitFileState | null>;

/** Resolve a workspace-relative `file` to its owning repo (longest matching `repos[].path`
 *  prefix, so a repo nested under another repo's path still resolves to the innermost one),
 *  then ask git whether it's clean and when it was last committed — scoped to that one file via
 *  a pathspec, never a whole-repo status walk. Null means "cannot assess": no repo claims this
 *  path, or git itself failed (repo not cloned yet, corrupt, etc.) — never treat null as clean. */
export async function gitFileState(root: string, manifest: WorkspaceManifest, file: string): Promise<GitFileState | null> {
  const repo = manifest.repos
    .filter((r) => file === r.path || file.startsWith(`${r.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  if (!repo) return null;
  const rel = file === repo.path ? '' : file.slice(repo.path.length + 1);
  if (!rel) return null; // claim names a repo root, not a file inside it — not an expected shape

  const repoDir = join(root, repo.path);
  try {
    const status = await gitRun(repoDir, ['status', '--porcelain', '--', rel]);
    const clean = status.stdout.trim().length === 0;
    const log = await gitRun(repoDir, ['log', '-1', '--format=%cI', '--', rel]);
    const lastCommitAt = log.stdout.trim() || null;
    // `git status --porcelain -- <ignored-path>` prints NOTHING even while that file is being
    // actively rewritten (verified: status exits 0, empty stdout, mid-edit). So "clean AND no
    // commit history" is ambiguous — it's either a genuinely untouched path or a gitignored
    // file under live edit. The second reads as `idle-clean` forever, i.e. the mechanism would
    // flag the claims that are protecting real work hardest. Not hypothetical here: this very
    // workspace gitignores CLAUDE.local.md and other local-only docs. Downgrade to "cannot assess".
    // Only fires on that ambiguous branch, so tracked files never pay the extra process.
    if (clean && !lastCommitAt && (await isIgnored(repoDir, rel))) return null;
    return { clean, lastCommitAt };
  } catch {
    return null;
  }
}

/** Does git ignore `rel`? `check-ignore` exits 0 when ignored, 1 when not, and >1 on error —
 *  so it can't go through `gitRun`, which throws on any nonzero. It is index-aware: a TRACKED
 *  file later added to .gitignore reports NOT ignored (exit 1), so this can never suppress
 *  assessment of tracked work. An error reports "not ignored" and leaves the decision to the
 *  caller's own catch. */
async function isIgnored(repoDir: string, rel: string): Promise<boolean> {
  const r = await execa('git', ['check-ignore', '-q', '--', rel], { cwd: repoDir, reject: false });
  return r.exitCode === 0;
}

// Long enough that a claim taken moments before its first real edit never false-flags as
// idle-clean — short enough to still catch the incident's 24-minute hold well before an
// operator would otherwise notice and hand-diagnose it.
export const DEFAULT_IDLE_GRACE_MS = 5 * 60_000;

export type StalenessVerdict =
  | { stale: false }
  | { stale: true; reason: 'clean-since-commit'; committedAt: string }
  | { stale: true; reason: 'idle-clean'; claimAgeMs: number };

export interface AssessOpts {
  idleGraceMs?: number;
  fetchState?: GitFileStateFn; // test seam — see tests/staleness.test.ts
}

export async function assessStaleness(
  root: string,
  manifest: WorkspaceManifest,
  claim: Claim,
  nowMs: number,
  opts: AssessOpts = {},
): Promise<StalenessVerdict> {
  const fetchState = opts.fetchState ?? gitFileState;
  const state = await fetchState(root, manifest, claim.file);
  if (!state || !state.clean) return { stale: false }; // dirty, or no evidence — never touch it

  const claimedAtMs = Date.parse(claim.claimed_at);
  if (Number.isNaN(claimedAtMs)) return { stale: false };

  if (state.lastCommitAt) {
    const commitMs = Date.parse(state.lastCommitAt);
    if (!Number.isNaN(commitMs) && commitMs >= claimedAtMs) {
      return { stale: true, reason: 'clean-since-commit', committedAt: state.lastCommitAt };
    }
  }

  // No qualifying post-claim commit: state.lastCommitAt is either null (never committed) or
  // older than claimedAtMs — either way the file has been clean for this claim's entire life.
  // Flag it once that life is long enough to rule out "just claimed, about to edit".
  const claimAgeMs = nowMs - claimedAtMs;
  if (claimAgeMs >= (opts.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS)) {
    return { stale: true, reason: 'idle-clean', claimAgeMs };
  }
  return { stale: false };
}
