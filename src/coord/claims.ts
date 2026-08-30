// File-claim registry for the edit-gate backstop (Phase 2).
//
// A claim is created the first time a session actually edits a file
// (claim-on-first-touch). The PreToolUse Edit/Write hook reserves the file
// before the edit lands; any other live session that tries the same file is
// denied. This is the runtime net that catches collisions the plan layer
// missed — order of *editing* decides the lock, not order of *planning*, which
// is what closes the blind-first-registrant gap.
//
// Atomicity: a brand-new claim is created with the exclusive `wx` flag, so when
// two sessions race for an unheld file exactly one create succeeds; the loser
// sees EEXIST, reads the winner's fresh claim, and is denied. Stored one file
// per claim (hashed name) under `<workspace>/.repolith/claims/`.
//
// Liveness (P1c): the flat per-file TTL alone can't tell "the holder crashed"
// apart from "the holder is quiet on this file but still working elsewhere" — see
// heartbeat.ts. A takeover of a TTL-expired claim additionally requires the
// holding session's heartbeat to be stale.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, unlink, rename, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { touchHeartbeat, isSessionAlive, clearHeartbeat } from './heartbeat.js';
import { fileKey } from './fileKey.js';
import { readRevocation, clearRevocation, OVERRIDE_HOLDER } from './revocation.js';

export const DEFAULT_CLAIM_TTL = 1800; // 30 min; renewed on every touch

export interface Claim {
  file: string; // workspace-relative, forward-slashed
  session_id: string;
  claimed_at: string; // ISO
  ttl_sec: number;
}

export type ClaimOutcome =
  | { ok: true; status: 'new' | 'renewed' | 'took-over'; file: string }
  // `revoked` marks the one denial that is NOT a live collision: the operator overrode this
  // session off the file (revocation.ts). Optional so every existing consumer of the `held`
  // shape keeps working untouched — only the deny-message builder branches on it.
  | { ok: false; status: 'held'; file: string; held_by: string; claimed_at: string; revoked?: { at: string } };

const claimsDir = (root: string): string => join(root, '.repolith', 'claims');
const hashName = (file: string): string => createHash('sha256').update(fileKey(file)).digest('hex').slice(0, 16) + '.json';
const pathFor = (root: string, file: string): string => join(claimsDir(root), hashName(file));

const isFresh = (c: Claim, nowMs: number): boolean => {
  const t = Date.parse(c.claimed_at);
  return !Number.isNaN(t) && nowMs - t < c.ttl_sec * 1000;
};

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Claim a file for a session. Atomic for the common "first claim wins" path. */
export async function claimFile(
  root: string,
  file: string,
  sessionId: string,
  nowMs: number,
  ttlSec = DEFAULT_CLAIM_TTL,
): Promise<ClaimOutcome> {
  await mkdir(claimsDir(root), { recursive: true });
  await touchHeartbeat(root, sessionId, nowMs); // this session is acting, on any file, any outcome
  const path = pathFor(root, file);
  const body = JSON.stringify({ file, session_id: sessionId, claimed_at: new Date(nowMs).toISOString(), ttl_sec: ttlSec }, null, 2) + '\n';

  // Operator-override bar. Checked BEFORE the create, never as a roll-back after it: a
  // create-then-unlink would hold the claim for the width of the rollback and deny the very
  // session the override was meant to unblock — and if the process died in that window the
  // booted session would have silently re-acquired exactly what the operator took away.
  // Reading first needs no lock (the record is keyed by file hash) and leaves the slot free
  // for whoever the override was for.
  const bar = await readRevocation(root, file, nowMs);
  if (bar && bar.revoked_session === sessionId) {
    return { ok: false, status: 'held', file, held_by: OVERRIDE_HOLDER, claimed_at: bar.revoked_at, revoked: { at: bar.revoked_at } };
  }

  try {
    await writeFile(path, body, { flag: 'wx' }); // atomic create — first claim wins
    // The override has served its purpose the moment someone else takes the file: drop the
    // bar so a later, unrelated collision here isn't refused by a stale revocation.
    if (bar) await clearRevocation(root, file);
    return { ok: true, status: 'new', file };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }

  // Someone holds it. Read with one retry to dodge a mid-write window.
  let existing: Claim | null = await readClaim(path);
  if (!existing) {
    await delay(10);
    existing = await readClaim(path);
  }
  if (!existing) {
    // Unreadable but present — treat as contended, do NOT clobber a possibly-fresh claim.
    return { ok: false, status: 'held', file, held_by: 'unknown', claimed_at: new Date(nowMs).toISOString() };
  }
  if (existing.session_id === sessionId) {
    await writeFile(path, body); // renew my own claim
    return { ok: true, status: 'renewed', file };
  }
  if (!isFresh(existing, nowMs) && !(await isSessionAlive(root, existing.session_id, nowMs, existing.ttl_sec * 1000))) {
    // Take over a claim that's both TTL-expired AND whose holder is quiet everywhere.
    // Must be as atomic as the create path above, or two sessions that independently
    // judge the same dead holder both "take over" and both believe they hold the file —
    // the exact multi-agent race this registry exists to prevent. unlink-then-`wx`
    // gives us that: whoever creates first wins, the loser sees EEXIST and re-reads.
    // NB: if this process dies between the unlink and the create, the dead holder's claim
    // is simply dropped — the intended outcome, since we only reach here once the holder
    // is confirmed both TTL-expired and heartbeat-silent.
    await unlink(path).catch(() => {}); // already gone = fine; another taker beat us to it
    try {
      await writeFile(path, body, { flag: 'wx' });
      return { ok: true, status: 'took-over', file };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      // Someone created a claim between our unlink and our create. Re-read and honor it
      // rather than clobbering — this also closes the taker-vs-renewer window, where the
      // "dead" holder was renewing (see the renew branch above) while we judged it dead:
      // their renewal re-creates the file and we back off instead of stealing a live claim.
      const winner = await readClaim(path);
      if (!winner) return { ok: false, status: 'held', file, held_by: 'unknown', claimed_at: new Date(nowMs).toISOString() };
      if (winner.session_id === sessionId) return { ok: true, status: 'renewed', file };
      return { ok: false, status: 'held', file, held_by: winner.session_id, claimed_at: winner.claimed_at };
    }
  }
  return { ok: false, status: 'held', file, held_by: existing.session_id, claimed_at: existing.claimed_at };
}

/** Is this file claimed by another live session? Mirrors claimFile's liveness rule — and its
 *  override bar — so observers agree with what an actual claim attempt would do. Non-mutating
 *  on claims; the only write it can cause is sweeping a lapsed `.revoked` record on read, the
 *  same lazy cleanup listClaims does for expired claims. */
export async function checkFile(root: string, file: string, sessionId: string, nowMs: number): Promise<ClaimOutcome> {
  // Mirror the bar first, exactly as claimFile orders it: a waiter that polls this must not be
  // told the file is free when its own claim attempt would be refused.
  const bar = await readRevocation(root, file, nowMs);
  if (bar && bar.revoked_session === sessionId) {
    return { ok: false, status: 'held', file, held_by: OVERRIDE_HOLDER, claimed_at: bar.revoked_at, revoked: { at: bar.revoked_at } };
  }
  const existing = await readClaim(pathFor(root, file));
  if (!existing) return { ok: true, status: 'new', file };
  if (existing.session_id === sessionId) return { ok: true, status: 'renewed', file };
  if (!isFresh(existing, nowMs) && !(await isSessionAlive(root, existing.session_id, nowMs, existing.ttl_sec * 1000))) {
    return { ok: true, status: 'took-over', file };
  }
  return { ok: false, status: 'held', file, held_by: existing.session_id, claimed_at: existing.claimed_at };
}

export async function listClaims(root: string, nowMs: number): Promise<Claim[]> {
  let names: string[];
  try {
    names = await readdir(claimsDir(root));
  } catch {
    return [];
  }
  const out: Claim[] = [];
  for (const name of names) {
    const p = join(claimsDir(root), name);
    if (name.endsWith('.reap')) {
      // Tombstone orphaned by a pruner that died mid-verify — invisible to every sweep
      // (they filter on `.json`), but clean it up once it's clearly abandoned. Live
      // verify windows are milliseconds; minutes-old means the owner is gone.
      try {
        const s = await stat(p);
        if (nowMs - s.mtimeMs > 5 * 60_000) await unlink(p).catch(() => {});
      } catch {
        /* already gone */
      }
      continue;
    }
    if (!name.endsWith('.json')) continue;
    const c = await readClaim(p);
    if (!c) continue;
    if (isFresh(c, nowMs) || (await isSessionAlive(root, c.session_id, nowMs, c.ttl_sec * 1000))) {
      out.push(c); // fresh, or TTL-expired but the holder is still active elsewhere
    } else {
      // Lazy prune of expired-and-quiet claims. Re-judged under the tombstone (§7 TOCTOU):
      // a renewal that landed after the read above must be restored, not destroyed.
      await removeClaimIf(p, async (cur) => !isFresh(cur, nowMs) && !(await isSessionAlive(root, cur.session_id, nowMs, cur.ttl_sec * 1000)));
    }
  }
  return out;
}

export async function releaseSession(root: string, sessionId: string): Promise<number> {
  const n = await releaseWhere(root, (c) => c.session_id === sessionId);
  await clearHeartbeat(root, sessionId); // releasing everything = stepping back; don't leave a heartbeat with nothing to protect
  return n;
}

export async function releaseFiles(
  root: string,
  files: string[],
  sessionId?: string,
  rawRename?: RenameFn, // test seam: inject a failing/flaky rename to exercise the locked-file path
): Promise<number> {
  const want = new Set(files);
  return releaseWhere(root, (c) => want.has(c.file) && (!sessionId || c.session_id === sessionId), rawRename);
}

/** The session currently holding `file`, or null if unheld/unreadable. Read-only and
 *  liveness-agnostic on purpose: its caller is the operator override, which needs to know
 *  whose claim it is about to delete — including a TTL-expired one it is about to sweep. */
export async function claimHolder(root: string, file: string): Promise<string | null> {
  const c = await readClaim(pathFor(root, file));
  return c?.session_id ?? null;
}

async function readClaim(path: string): Promise<Claim | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as Claim;
  } catch {
    return null;
  }
}

export type RenameFn = (from: string, to: string) => Promise<void>;

// Best-effort tombstone deletion with a brief retry for transient Windows handle locks.
// A tombstone that survives is inert (every sweep filters on `.json`) and gets cleaned
// up by listClaims' orphan sweep, so failure here never falsifies a release count.
async function removeTombstone(p: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await unlink(p);
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      await delay(20 * (attempt + 1));
    }
  }
}

let tombSeq = 0;

// Verified removal for every read-then-delete sweep (lazy prune, releaseWhere). A plain
// read → judge → unlink is TOCTOU: a legitimate renewal landing between the read and the
// unlink is destroyed, freeing the file while its holder still believes they hold it.
// Instead, atomically rename the claim aside to a per-call tombstone, re-judge the content
// actually captured, and only then delete. If the captured record no longer satisfies
// `stillMatches` (a renewal/takeover won the race), restore it byte-for-byte with `wx` —
// and if even that loses (the slot was re-created meanwhile), the newer claim wins and the
// tombstone is discarded. A renewal racing the other way (after our rename) simply
// re-creates the claim file via its plain writeFile, so the holder keeps the file either way.
//
// The rename is ALSO where the ghost-claim guarantee (§6) now lives: a Windows handle held
// without FILE_SHARE_DELETE (PowerShell's Get-Content in coord-push.ps1, AV scanners) fails
// rename with the same EPERM/EBUSY it fails unlink with, so a locked record is retried and
// then honestly reported as NOT released — never counted while it still denies on disk.
async function removeClaimIf(
  p: string,
  stillMatches: (c: Claim) => boolean | Promise<boolean>,
  rawRename: RenameFn = rename,
): Promise<boolean> {
  const tomb = `${p}.${process.pid.toString(36)}${(tombSeq++).toString(36)}.reap`;
  for (let attempt = 0; ; attempt++) {
    try {
      await rawRename(p, tomb);
      break;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return true; // already gone — idempotent success
      if (attempt >= 3) return false; // still locked after retries — do NOT count it as released
      await delay(20 * (attempt + 1));
    }
  }
  let raw: string | null = null;
  try {
    raw = await readFile(tomb, 'utf8');
  } catch {
    raw = null;
  }
  let cur: Claim | null = null;
  if (raw !== null) {
    try {
      cur = JSON.parse(raw) as Claim;
    } catch {
      cur = null;
    }
  }
  if (!cur || (await stillMatches(cur))) {
    // Still the record we judged (or unreadable — we only get here after a successful
    // read judged it, so unreadable means it broke under us; reap it). The claim is
    // released the moment the rename landed; tombstone deletion is best-effort.
    await removeTombstone(tomb);
    return true;
  }
  // The record changed between the read and the rename (renewal / takeover) — put back
  // exactly what was captured. `wx`: if the slot was re-created meanwhile, theirs is
  // newer and wins.
  try {
    await writeFile(p, raw as string, { flag: 'wx' });
  } catch {
    /* newer claim already in place — keep it */
  }
  await removeTombstone(tomb);
  return false;
}

async function releaseWhere(root: string, pred: (c: Claim) => boolean, rawRename: RenameFn = rename): Promise<number> {
  let names: string[];
  try {
    names = await readdir(claimsDir(root));
  } catch {
    return 0;
  }
  let n = 0;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = join(claimsDir(root), name);
    const c = await readClaim(p);
    if (c && pred(c)) {
      // Re-judged under the tombstone (§7): count only removals whose record still
      // matched `pred` at removal time — a takeover by a session outside the predicate
      // is restored, not silently destroyed.
      if (await removeClaimIf(p, pred, rawRename)) n++;
    }
  }
  return n;
}
