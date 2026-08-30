// Edit-gate CLI surface (Phase 2).
//
// `edit-hook`  — the command the PreToolUse Edit/Write hook invokes. Reads the
//                hook payload on stdin, resolves the workspace-relative path of
//                the file being edited, and claims it. If another live session
//                already holds the file, prints a PreToolUse `deny` to block the
//                edit and name the holder. Otherwise exits 0 (normal flow).
// `claim list` / `claim release` — inspect and release file claims.
//                `claim release --committed` is what the post-commit git hook
//                runs: it releases the claims on the files just committed.
//                `claim release --stale` releases claims the git history itself
//                already proves are safe to drop — see coord/staleness.ts.

import { dirname, relative, resolve, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import pLimit from 'p-limit';
import { findManifestUp } from '../locate.js';
import { readHookStdin } from './hook-stdin.js';
import { claimFile, listClaims, releaseSession, releaseFiles, claimHolder, DEFAULT_CLAIM_TTL, type Claim } from '../coord/claims.js';
import { writeRevocation, REVOCATION_TTL_SEC } from '../coord/revocation.js';
import { isAppendOnlyFile } from '../coord/appendOnly.js';
import { waitForClaim, listWaits } from '../coord/waits.js';
import { selfInvocation } from '../coord/invocation.js';
import { appendNote, appendDenyNote } from '../coord/journal.js';
import { buildBrief } from '../coord/brief.js';
import { pushSnapshot, PUSH_URGENT_MS } from '../coord/snapshotPush.js';
import { assessStaleness, type StalenessVerdict } from '../coord/staleness.js';
import { parseManifest } from '../manifest.js';
import type { WorkspaceManifest } from '../types.js';
import { gitRun } from '../git.js';
import { cleanContext } from '../coord/sanitize.js';

interface EditPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
}

// In-hook bounded auto-wait on collision (see the comment at its call site in editHook).
// Installed edit-hook timeout is 15s (hooks.ts) and fails OPEN on expiry — this leaves
// several seconds of margin for the rest of the hook's work either way.
const INLINE_WAIT_MS = 6000;
const INLINE_POLL_MS = 1000;

/** Workspace-relative, forward-slashed path — or null if the file is outside the workspace.
 *  Exported because every hook that turns an untrusted payload-supplied path into a store
 *  key must apply the SAME containment rule — see readPlanText (commands/plan.ts). */
export function relInWorkspace(root: string, absFile: string): string | null {
  const rel = relative(root, absFile).replace(/\\/g, '/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

export async function editHook(): Promise<void> {
  const raw = (await readHookStdin()).trim();
  if (!raw) return;
  let ev: EditPayload;
  try {
    ev = JSON.parse(raw) as EditPayload;
  } catch {
    return; // unparseable → never break the edit flow
  }
  const filePath = ev.tool_input?.file_path;
  if (!filePath) return;

  const manifestPath = await findManifestUp(ev.cwd || dirname(filePath));
  if (!manifestPath) return; // not a repolith workspace
  const root = dirname(manifestPath);
  const rel = relInWorkspace(root, isAbsolute(filePath) ? filePath : resolve(root, filePath));
  if (!rel) return; // edit outside the workspace → not ours

  // No session identity → bail, like bash-pre/post-hook and spec-hook (finding 12). The
  // old `hook-${pid}` fallback minted a NEW identity per hook process — a claim such a
  // "session" took could never be renewed or released by its own later hooks.
  const sessionId = ev.session_id;
  if (!sessionId) return;

  if (await isAppendOnlyFile(root, rel)) {
    // Shared log — never gate, but still leave the "someone touched this" signal
    // so it's reviewable after the fact, same as any other first touch.
    await appendNote(root, { file: rel, kind: 'claim', msg: 'editing (append-only, exempt from claim gate)', session_id: sessionId, ts: new Date().toISOString() }).catch(() => {});
    return; // always allow
  }

  let outcome = await claimFile(root, rel, sessionId, Date.now(), DEFAULT_CLAIM_TTL);

  if (!outcome.ok) {
    // Most collisions are the holder mid-turn, about to release in seconds (a commit, the
    // next edit finishing) — not a genuinely long hold. No interactive agent is going to run
    // the foreground `claim wait` itself (it can block a turn for up to 10 min), so without
    // this the FIFO auto-resume machinery never actually engages and every short overlap
    // becomes a hard deny the agent either retries a couple times or just gives up on.
    // A brief in-hook wait fixes that transparently. Safe to spend: PreToolUse hooks fail
    // OPEN on timeout (verified against code.claude.com/docs/hooks — a killed hook just lets
    // the edit through, never hangs or blocks), and this stays well under the 15s timeout
    // this hook is installed with (hooks.ts), leaving margin for the rest of the hook's work.
    // waitForClaim already claims (mutating) the instant it acquires — never re-derive that
    // via checkFile, which is non-mutating and would report `ok` without ever registering
    // our claim. On a still-contended timeout, one more real claimFile attempt both catches
    // the file freeing up in the last instant AND gives the deny message an accurate holder.
    const resumed = await waitForClaim(root, rel, sessionId, { timeoutMs: INLINE_WAIT_MS, pollMs: INLINE_POLL_MS });
    outcome = resumed.acquired
      ? { ok: true, status: 'new', file: rel }
      : await claimFile(root, rel, sessionId, Date.now(), DEFAULT_CLAIM_TTL);
  }

  if (outcome.ok) {
    // First touch of this file → append a claim note (so later sessions inherit the
    // "who's editing" signal) then inject a read-before-touch brief + self-anchor.
    // Renewed claims stay silent. Best-effort throughout.
    if (outcome.status === 'new' || outcome.status === 'took-over') {
      await appendNote(root, { file: rel, kind: 'claim', msg: 'editing', session_id: sessionId, ts: new Date().toISOString() }).catch(() => {});
      const brief = await buildBrief(root, sessionId, rel, Date.now()).catch(() => null);
      if (brief) {
        process.stdout.write(
          JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: brief } }),
        );
      }
      await pushSnapshot(root); // a new/changed claim → refresh the live dashboard (throttled)
    }
    return; // claimed → allow
  }

  // Log the collision so it's reviewable after the fact (deny notes are advisory — recorded
  // for observability, not surfaced in the read-before-touch brief). Best-effort.
  // An override refusal is not a collision — there is no holder. Record it as what it is, or
  // the journal (and the dashboard reading it) shows a phantom session holding the file.
  if (outcome.revoked) {
    await appendNote(root, {
      file: outcome.file,
      kind: 'deny',
      msg: `edit blocked — this session was overridden off the file by the operator`,
      session_id: sessionId,
      ts: new Date().toISOString(),
    }).catch(() => {});
  } else {
    await appendDenyNote(root, outcome.file, sessionId, outcome.held_by, new Date().toISOString());
  }

  // Suggest commands that actually resolve here — `repolith` if installed, else the
  // `bun run …/src/cli.ts` this very hook was launched as (the published bin lacks `claim`).
  // Store-sourced holder id / file are cleaned at the injection sink — finding 10.
  const cmd = selfInvocation();
  const heldBy = cleanContext(outcome.held_by, 80);
  const heldFile = cleanContext(outcome.file, 200);
  if (outcome.revoked) {
    // Deliberately offers no override command: the operator ALREADY decided this session is
    // not the one that should hold this file. Suggesting `claim release` here would hand the
    // booted session a one-liner to undo the very override it just hit.
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason:
            `repolith: your claim on ${heldFile} was force-released by the operator ${ago(outcome.revoked.at)}, ` +
            `because another session was waiting on this file. That session may be editing it right now. ` +
            `Do NOT re-take it — re-read the file before you touch it again; your copy is likely stale. ` +
            `The bar lifts automatically ${REVOCATION_TTL_SEC / 60} min after the override.`,
        },
      }),
    );
    await pushSnapshot(root, PUSH_URGENT_MS);
    return;
  }
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `repolith: ${heldFile} is being edited by another active session (${heldBy}, claimed ${ago(outcome.claimed_at)}). ` +
          `Already auto-waited ~${INLINE_WAIT_MS / 1000}s for it to free up — still held, so this is a longer hold, not a fluke. ` +
          `Auto-resume: \`${cmd} claim wait --file ${heldFile} --session ${sessionId}\` blocks until they release (e.g. on commit), then it's yours — retry the edit. ` +
          `Or check \`${cmd} claim list\` for a [STALE] tag and \`${cmd} claim release --file ${heldFile} --stale\` if so. ` +
          `Or override now: \`${cmd} claim release --file ${heldFile}\`.`,
      },
    }),
  );

  // Push AFTER the deny is on stdout, never before. The inline auto-wait above can burn
  // INLINE_WAIT_MS (6s), which lapses the push throttle, so this call spawns and awaits
  // PowerShell for up to UPLOAD_TIMEOUT_MS (8s) — 14s against the 15s hook timeout this
  // hook is installed with (hooks.ts). PreToolUse fails OPEN on timeout, so ordering the
  // push first meant a slow Blob upload could get the hook killed and let the collided
  // edit through with no deny message at all — losing the warning in exactly the
  // genuinely-contended case it exists for. Emitting first makes the deny survive.
  await pushSnapshot(root, PUSH_URGENT_MS); // a collision is the urgent signal — push promptly
}

export async function claimWait(
  manifestPath: string,
  opts: { file: string; session?: string; timeout?: string; poll?: string },
): Promise<void> {
  if (!opts.session) {
    // The acquired claim must carry the SAME id the edit-hook checks on retry, or
    // the retried edit denies itself. Never silently default to a different id.
    console.error(
      '`claim wait` requires --session <your Claude session id> — it must match the id in your deny message so the retried edit sees the claim as yours.',
    );
    process.exit(1);
  }
  const root = dirname(resolve(manifestPath));
  const sessionId = opts.session;
  // Relative paths go through the SAME containment check as absolute ones (finding 13):
  // resolve against the workspace root, then reject anything that escapes (`../../x`).
  const file = relInWorkspace(root, isAbsolute(opts.file) ? opts.file : resolve(root, opts.file));
  if (!file) {
    console.error('That file is outside the workspace.');
    process.exit(1);
  }
  const res = await waitForClaim(root, file, sessionId, {
    timeoutMs: Number(opts.timeout ?? 600) * 1000,
    pollMs: Number(opts.poll ?? 2000),
  });
  if (res.acquired) {
    console.log(`Acquired ${file} after ${Math.round(res.waited_ms / 1000)}s — it's yours now, retry your edit.`);
    return;
  }
  if (res.reason === 'deadlock') {
    console.error(
      `Deadlock: you and session ${res.held_by} each hold a file the other is waiting on, ` +
        `and you were elected to yield (one member of the cycle keeps waiting so the whole ring isn't stuck). ` +
        `Break it — release a file you hold (\`repolith claim release\`) or re-scope; the other session acquires the moment you do.`,
    );
    process.exit(2);
  }
  console.error(`Timed out waiting for ${file} (held by ${res.held_by}). It may be a long-running edit — retry or coordinate.`);
  process.exit(1);
}

/** Best-effort manifest load for staleness assessment. Never throws — a claim-list or
 *  claim-release call must still work even if the manifest is briefly unreadable; callers
 *  fall back to reporting no staleness info rather than failing the whole command. */
async function loadManifestSafe(manifestPath: string): Promise<WorkspaceManifest | null> {
  try {
    return parseManifest(await readFile(manifestPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Assess every claim, in claim order, but concurrently — each assessment spawns 2-3 git
 *  processes and `claim list` is the command the edit-hook deny message now tells blocked
 *  agents to run, so a serial walk would make it slower the more contended the workspace is
 *  (exactly when someone needs it). Same cap and env override the repo dispatcher uses. */
async function assessAll(
  root: string,
  manifest: WorkspaceManifest | null,
  claims: Claim[],
  nowMs: number,
): Promise<StalenessVerdict[]> {
  if (!manifest) return claims.map(() => ({ stale: false }));
  const limit = pLimit(Number(process.env['REPOLITH_CONCURRENCY'] ?? 8));
  return Promise.all(
    claims.map((c) =>
      limit(() => assessStaleness(root, manifest, c, nowMs).catch(() => ({ stale: false }) as StalenessVerdict)),
    ),
  );
}

/** Human-readable suffix for `claim list` — empty string for a live claim. */
function staleTag(v: StalenessVerdict): string {
  if (!v.stale) return '';
  if (v.reason === 'clean-since-commit') return `  [STALE — committed ${ago(v.committedAt)}, safe to release]`;
  return `  [idle-clean ${Math.round(v.claimAgeMs / 60000)}m — never dirtied under this claim, flagged not released]`;
}

export async function claimList(manifestPath: string): Promise<void> {
  const root = dirname(resolve(manifestPath));
  const claims = await listClaims(root, Date.now());
  if (!claims.length) {
    console.log('No active file claims.');
    return;
  }
  // Staleness needs the manifest to resolve which repo owns each claimed file; a manifest
  // read failure degrades to plain listing (no tags) rather than failing the whole command.
  const manifest = await loadManifestSafe(manifestPath);
  const verdicts = await assessAll(root, manifest, claims, Date.now());
  claims.forEach((c, i) => {
    console.log(`${c.file}  ←  ${c.session_id}  (${ago(c.claimed_at)})${staleTag(verdicts[i]!)}`);
  });
}

export async function claimWaits(manifestPath: string): Promise<void> {
  const root = dirname(resolve(manifestPath));
  const waits = await listWaits(root, Date.now());
  if (!waits.length) {
    console.log('No sessions are waiting.');
    return;
  }
  for (const w of waits) console.log(`${w.session_id}  waits on  ${w.held_by}  (for ${w.file})`);
}

export async function claimRelease(
  manifestPath: string,
  opts: { file?: string; session?: string; committed?: boolean; stale?: boolean; includeIdle?: boolean },
): Promise<void> {
  if (opts.committed) {
    const n = await releaseCommitted(process.cwd());
    console.log(`Released ${n} claim(s) for the committed files.`);
    return;
  }

  if (opts.stale) {
    await releaseStale(manifestPath, opts);
    return;
  }

  const root = dirname(resolve(manifestPath));
  if (opts.file) {
    // Same containment rule as claimWait (finding 13) — a relative `../../x` must not
    // silently become a store key.
    const f = relInWorkspace(root, isAbsolute(opts.file) ? opts.file : resolve(root, opts.file));
    // Who are we booting? Read BEFORE the release — afterwards the record is gone and the
    // holder is unrecoverable. This is the only call site that turns a release into an
    // override, so it is the only one that writes a revocation: `releaseFiles` itself stays
    // the plain "I'm done with this file" primitive that commit-release and FIFO handoff use.
    const booted = f ? await claimHolder(root, f) : null;
    const n = f ? await releaseFiles(root, [f]) : 0;
    // Bar only the session we just took the file from, and only if we actually took it —
    // releasing an unheld file is a no-op, not an override, and must bar nobody.
    if (f && booted && n > 0) await writeRevocation(root, f, booted, Date.now());
    await pushSnapshot(root, PUSH_URGENT_MS); // released a held file → clear it from the live panels
    console.log(`Released ${n} claim(s) for ${opts.file}.`);
    if (booted && n > 0) {
      console.log(
        `${booted} is barred from ${opts.file} for ${REVOCATION_TTL_SEC / 60} min so it can't silently re-take the file before you do.`,
      );
    }
    return;
  }
  if (opts.session) {
    const n = await releaseSession(root, opts.session);
    await pushSnapshot(root, PUSH_URGENT_MS); // released a session's holds → clear them from the live panels
    console.log(`Released ${n} claim(s) held by ${opts.session}.`);
    return;
  }
  console.log('Specify --file <path>, --session <id>, --committed, or --stale.');
}

/** `claim release --stale` — the automated version of the incident's manual safe-override
 *  test (git clean + holder already committed). Never touches a dirty file. `clean-since-
 *  commit` claims release unconditionally (that IS the "auto-release on holder-commit" the
 *  mechanism exists to deliver); `idle-clean` claims are weaker evidence (a claim could just
 *  be seconds away from its first real edit) so they're reported as flagged, not released,
 *  unless the caller opts in with --include-idle. No revocation is written on either path —
 *  unlike an explicit human `claim release --file`, an automatic stale-takeover isn't a
 *  "don't come back" override; the original holder may legitimately touch the file again
 *  for unrelated reasons and that's just a normal new claim, not a collision to bar. */
async function releaseStale(manifestPath: string, opts: { file?: string; includeIdle?: boolean }): Promise<void> {
  const root = dirname(resolve(manifestPath));
  const manifest = await loadManifestSafe(manifestPath);
  if (!manifest) {
    console.error('repolith: could not read the workspace manifest — cannot assess staleness safely, nothing released.');
    process.exit(1);
  }
  const nowMs = Date.now();
  const all = await listClaims(root, nowMs);

  let targetFile: string | undefined;
  if (opts.file) {
    const f = relInWorkspace(root, isAbsolute(opts.file) ? opts.file : resolve(root, opts.file));
    if (!f) {
      console.error('That file is outside the workspace.');
      process.exit(1);
    }
    targetFile = f;
  }
  const candidates = targetFile ? all.filter((c) => c.file === targetFile) : all;
  if (targetFile && candidates.length === 0) {
    console.log(`No active claim on ${opts.file} — nothing to release.`);
    return;
  }

  const verdicts = await assessAll(root, manifest, candidates, nowMs);

  let flagged = 0;
  const toRelease: string[] = [];
  for (const [i, c] of candidates.entries()) {
    const verdict = verdicts[i]!;
    if (!verdict.stale) {
      if (targetFile) {
        console.error(
          `${c.file} is not provably stale — held by ${c.session_id}, ${ago(c.claimed_at)}, either dirty or ` +
            `no evidence the held edit already landed. Nothing released. Use a plain ` +
            `\`claim release --file ${opts.file}\` to override anyway.`,
        );
        process.exit(1);
      }
      continue; // sweep mode: silently skip live claims, only report at the end
    }
    if (verdict.reason === 'idle-clean' && !opts.includeIdle) {
      console.log(
        `Flagged ${c.file} — idle-clean for ${Math.round(verdict.claimAgeMs / 60000)}m, held by ${c.session_id}. ` +
          `NOT released (pass --include-idle to force).`,
      );
      flagged++;
      continue;
    }
    toRelease.push(c.file);
    const why =
      verdict.reason === 'clean-since-commit'
        ? `committed ${ago(verdict.committedAt)}, nothing left to protect`
        : `idle-clean ${Math.round(verdict.claimAgeMs / 60000)}m, never dirtied under this claim`;
    console.log(`Releasing ${c.file} (stale — ${why}).`);
  }

  let released = 0;
  if (toRelease.length) {
    released = await releaseFiles(root, toRelease);
    await pushSnapshot(root, PUSH_URGENT_MS);
  }
  // Counted off `toRelease`, not `released`: releaseFiles can legitimately return fewer (a
  // claim expiring between assessment and release), and that shortfall is not a live claim.
  if (!targetFile) {
    console.log(`${released} released, ${flagged} flagged, ${candidates.length - toRelease.length - flagged} still live.`);
  }
}

/** Release claims on the files of the latest commit in the given repo (post-commit hook). */
async function releaseCommitted(repoDir: string): Promise<number> {
  const manifestPath = await findManifestUp(repoDir);
  if (!manifestPath) return 0;
  const root = dirname(manifestPath);
  let files: string[];
  try {
    const { stdout } = await gitRun(repoDir, ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD']);
    files = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return 0;
  }
  const rels = files
    .map((f) => relInWorkspace(root, resolve(repoDir, f)))
    .filter((r): r is string => r !== null);

  // Leave a journal note on each committed file so the next session to touch it
  // inherits what changed (read-before-touch) instead of redoing/clobbering it.
  await writeCommitNotes(repoDir, root, rels);

  const n = rels.length ? await releaseFiles(root, rels) : 0;
  await pushSnapshot(root, PUSH_URGENT_MS); // commit = settled state (released claims + commit notes) → push it
  return n;
}

/** Append a `commit` journal note (subject + short sha) for each committed file. Best-effort. */
export async function writeCommitNotes(repoDir: string, root: string, rels: string[]): Promise<void> {
  if (!rels.length) return;
  let sha = '';
  let subject = '';
  try {
    const { stdout } = await gitRun(repoDir, ['log', '-1', '--format=%H%n%s']);
    const lines = stdout.trim().split('\n');
    sha = lines[0] ?? '';
    subject = lines.slice(1).join(' ').trim() || '(no subject)';
  } catch {
    return; // no commit / not a repo → nothing to note
  }
  const ts = new Date().toISOString();
  for (const file of rels) {
    await appendNote(root, { file, kind: 'commit', msg: subject, sha, ts });
  }
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return 'recently';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m === 1) return '1 min ago';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
