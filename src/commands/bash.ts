// `bash-pre-hook` / `bash-post-hook` — Bash-bypass backstop (P1.5).
//
// The Edit/Write gate only sees Edit/Write tool calls; `sed -i`, `git
// checkout`, codegen scripts mutate files via Bash entirely outside it.
// Bracket every Bash call: bash-pre-hook snapshots the workspace's dirty-file
// fingerprints before the command runs; bash-post-hook re-snapshots after and
// claims whatever changed for this session — same claim/journal/brief
// machinery as the Edit/Write gate, fired reactively (a command already ran
// by the time PostToolUse fires, so this can only record + warn, never deny).
//
// Baseline is keyed by session_id (the hook payload carries no per-tool-call
// id — verified live against docs.claude.com/hooks 2026-06-30), so two Bash
// calls issued in parallel within the same session share one baseline and the
// second's diff is measured against the first's post-state, not a true
// pre-state. Accepted edge case — sequential Bash calls (the common case) are
// unaffected.
//
// The bracket isolates "what changed during my command's execution window",
// NOT "what my command changed" — the workspace tree is shared, so if another
// session mutates a file (via its own Edit/Write or Bash) while this command
// is still running, that shows up in the after-snapshot too and gets
// attributed here. A long-running command (a test suite, a build) racing a
// concurrent editor on an unrelated file can produce a false collision
// warning, not just a true one.
//
// CONFIRMED live 2026-07-02 in the swfl-data-gulf dev workspace (brain-platform):
// a large Bash-driven edit burst's bracket kept catching a *different* session's
// own untracked plan doc mid-save and reporting it as "clobbered" by the burst's
// command, which never touched that file. Mitigation in `claimBashChanges`: when
// the touched file is held by another session, check that session's heartbeat
// against `bracketStartMs` (bash-pre-hook's snapshot time, not `nowMs`) — if the
// holder was itself claiming files *during this same window*, that's the far more
// likely explanation (their own concurrent edit) and we log a soft `note`, not a
// `deny`/clobber warning. Only warn when the holder's heartbeat predates the
// window entirely, i.e. they haven't touched anything since before this command
// started. Does not fix same-repo races where the rival's heartbeat is stale but
// the change still wasn't ours — that residual case is unresolvable without
// knowing what the command actually wrote, and is accepted.

import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import { findManifestUp } from '../locate.js';
import { parseManifest } from '../manifest.js';
import { readHookStdin } from './hook-stdin.js';
import { snapshotDirty, diffDirty, readBaseline, writeBaseline, type DirtyEntry } from '../coord/bashDiff.js';
import { claimFile, DEFAULT_CLAIM_TTL } from '../coord/claims.js';
import { heartbeatSeenMs } from '../coord/heartbeat.js';
import { isAppendOnlyFile } from '../coord/appendOnly.js';
import { appendNote } from '../coord/journal.js';
import { buildBrief } from '../coord/brief.js';
import { pushSnapshot, PUSH_URGENT_MS } from '../coord/snapshotPush.js';
import type { WorkspaceManifest } from '../types.js';
import { cleanContext } from '../coord/sanitize.js';

interface BashPayload {
  session_id?: string;
  cwd?: string;
}

// Bound the per-command claim loop — a bulk mutator (`prettier --write .`,
// `find -exec sed -i`) touching thousands of files must not blow the hook's
// timeout budget. Files beyond the cap are reported, not individually claimed.
const MAX_CLAIM = 50;
const MAX_BRIEF = 5;

export interface BashClaimResult {
  touched: string[];
  lines: string[];
  collided: boolean;
}

/**
 * Given the dirty-set snapshots from before and after a Bash command, claim
 * whatever changed for `sessionId` and report brief/collision lines. The core
 * of bash-post-hook, factored out so it's directly testable without faking
 * hook stdin (same split as `writeCommitNotes` in claim.ts).
 *
 * `bracketStartMs` is when the *before* snapshot was taken (bash-pre-hook's
 * clock, not this call's `nowMs`) — see the co-edit check below.
 */
export async function claimBashChanges(
  root: string,
  sessionId: string,
  before: DirtyEntry[],
  after: DirtyEntry[],
  nowMs: number,
  bracketStartMs: number = nowMs,
): Promise<BashClaimResult> {
  const touched = diffDirty(before, after);
  if (!touched.length) return { touched, lines: [], collided: false };

  const nowIso = new Date(nowMs).toISOString();
  const lines: string[] = [];
  let collided = false;

  const claimed = touched.slice(0, MAX_CLAIM);
  for (const file of claimed) {
    if (await isAppendOnlyFile(root, file)) {
      // Same exemption as the Edit/Write gate (claim.ts) — a shared, high-frequency
      // log written via Bash (`echo >> SESSION_LOG.md`) never goes through claim.ts
      // at all, so without this check it re-fights the whole-file lock on every
      // command and floods the journal with spurious "Bash overwrite" denies.
      await appendNote(root, {
        file,
        kind: 'claim',
        msg: 'editing via Bash (append-only, exempt from claim gate)',
        session_id: sessionId,
        ts: nowIso,
      }).catch(() => {});
      continue;
    }
    const outcome = await claimFile(root, file, sessionId, nowMs, DEFAULT_CLAIM_TTL);
    if (outcome.ok) {
      if (outcome.status === 'new' || outcome.status === 'took-over') {
        await appendNote(root, { file, kind: 'claim', msg: 'editing via Bash', session_id: sessionId, ts: nowIso }).catch(() => {});
        if (lines.length < MAX_BRIEF) {
          const brief = await buildBrief(root, sessionId, file, nowMs).catch(() => null);
          if (brief) lines.push(brief);
        }
      }
      continue;
    }
    // The bracket only proves "this file's fingerprint changed somewhere during my command's
    // execution window" — not that MY command is what changed it. If the file's rightful
    // holder was itself claiming files (any file, via touchHeartbeat) *during that same
    // window*, the far more likely explanation is their own concurrent edit landing while my
    // command happened to be running, not a clobber. Only warn when the holder's heartbeat
    // predates the window — i.e. they haven't touched anything since before my command
    // started, so an unexplained change to their file is actually suspicious.
    const rivalSeenMs = await heartbeatSeenMs(root, outcome.held_by);
    if (rivalSeenMs !== null && rivalSeenMs >= bracketStartMs) {
      await appendNote(root, {
        file: outcome.file,
        kind: 'coedit', // observability, not inheritable content — brief-excluded (see journal.ts NoteKind / brief.ts)
        msg: `also changed during this Bash command's window, but ${outcome.held_by} was actively claiming files in that same window — not attributed as a clobber`,
        session_id: sessionId,
        ts: nowIso,
      }).catch(() => {});
      continue;
    }
    collided = true;
    // Not appendDenyNote — nothing was blocked, the mutation already happened.
    await appendNote(root, {
      file: outcome.file,
      kind: 'deny',
      msg: `Bash overwrite — held by ${outcome.held_by}`,
      session_id: sessionId,
      ts: nowIso,
    }).catch(() => {});
    // Store-sourced holder id / file are cleaned at the injection sink — finding 10.
    const heldFile = cleanContext(outcome.file, 200);
    lines.push(
      `⚠️ Your last Bash command modified ${heldFile}, which is claimed by another active session (${cleanContext(outcome.held_by, 80)}). ` +
        `It may have clobbered in-progress work — check \`git diff ${heldFile}\` and coordinate before continuing.`,
    );
  }
  if (touched.length > MAX_CLAIM) {
    lines.push(
      `… and ${touched.length - MAX_CLAIM} more file(s) changed by this command — not claimed individually (bulk operation); run \`repolith claim list\` to review.`,
    );
  }

  return { touched, lines, collided };
}

async function parseEvent(): Promise<BashPayload | null> {
  const raw = (await readHookStdin()).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as BashPayload;
  } catch {
    return null; // unparseable → never break the bash flow
  }
}

async function loadWorkspace(cwd: string): Promise<{ root: string; manifest: WorkspaceManifest } | null> {
  const manifestPath = await findManifestUp(cwd);
  if (!manifestPath) return null; // not a repolith workspace
  const root = dirname(manifestPath);
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  return { root, manifest };
}

export async function bashPreHook(): Promise<void> {
  const ev = await parseEvent();
  if (!ev?.session_id) return;
  const ws = await loadWorkspace(ev.cwd || process.cwd());
  if (!ws) return;
  const dirty = await snapshotDirty(ws.root, ws.manifest);
  await writeBaseline(ws.root, ev.session_id, Date.now(), dirty);
}

export async function bashPostHook(): Promise<void> {
  const ev = await parseEvent();
  if (!ev?.session_id) return;
  const ws = await loadWorkspace(ev.cwd || process.cwd());
  if (!ws) return;

  const baseline = await readBaseline(ws.root, ev.session_id);
  const after = await snapshotDirty(ws.root, ws.manifest);
  const nowMs = Date.now();

  if (!baseline) {
    // No baseline (first Bash call this session, or bash-pre-hook missed/failed) —
    // prime it and stop. Without a "before" we can't isolate what THIS command
    // touched from whatever was already dirty, and guessing risks the false
    // collisions/claims this backstop exists to avoid.
    await writeBaseline(ws.root, ev.session_id, nowMs, after);
    return;
  }
  await writeBaseline(ws.root, ev.session_id, nowMs, after); // baseline for the next command

  const result = await claimBashChanges(ws.root, ev.session_id, baseline.dirty, after, nowMs, baseline.ts);
  if (!result.touched.length) return;

  await pushSnapshot(ws.root, result.collided ? PUSH_URGENT_MS : undefined);

  if (result.lines.length) {
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: result.lines.join('\n\n') } }),
    );
  }
}
