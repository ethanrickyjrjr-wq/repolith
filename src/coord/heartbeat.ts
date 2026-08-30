// Per-session liveness heartbeat (P1c).
//
// A file claim's `claimed_at` only advances when that SPECIFIC file is touched
// again, so a session that claims X and then spends 40 minutes on Y and Z (still
// working, just not on X) looks identical — from claims.ts's flat per-file TTL —
// to a session that crashed 40 minutes ago. Both read as "stale" and are eligible
// for takeover.
//
// The heartbeat fixes that by tracking liveness at the SESSION level instead of
// the file level: `claimFile` touches the calling session's heartbeat on every
// call, for any file, any outcome. A takeover of an expired claim is only allowed
// when the *holding* session's heartbeat has also gone stale — so a holder that's
// quiet on one file but still active elsewhere keeps the claim past the flat TTL.
// One file per session (hashed id) under `<workspace>/.repolith/heartbeat/`.

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

interface Heartbeat {
  session_id: string;
  seen: string; // ISO
}

const heartbeatDir = (root: string): string => join(root, '.repolith', 'heartbeat');
const sanitize = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 16);
const heartbeatPath = (root: string, sessionId: string): string => join(heartbeatDir(root), `${sanitize(sessionId)}.json`);

/** Refresh (or create) this session's heartbeat. Best-effort — a missed write just falls back to flat-TTL behavior. */
export async function touchHeartbeat(root: string, sessionId: string, nowMs: number): Promise<void> {
  try {
    await mkdir(heartbeatDir(root), { recursive: true });
    const body: Heartbeat = { session_id: sessionId, seen: new Date(nowMs).toISOString() };
    await writeFile(heartbeatPath(root, sessionId), JSON.stringify(body, null, 2) + '\n', 'utf8');
  } catch {
    /* best-effort */
  }
}

/** Has `sessionId` made any claimFile call within `staleMs`? No heartbeat on record reads as not alive. */
export async function isSessionAlive(root: string, sessionId: string, nowMs: number, staleMs: number): Promise<boolean> {
  try {
    const hb = JSON.parse(await readFile(heartbeatPath(root, sessionId), 'utf8')) as Heartbeat;
    const t = Date.parse(hb.seen);
    return !Number.isNaN(t) && nowMs - t < staleMs;
  } catch {
    return false;
  }
}

/** Raw last-seen time (ms) for a session's heartbeat, or null if none on record. Unlike
 *  `isSessionAlive` (a within-staleMs-of-now check), this returns the timestamp itself so a
 *  caller can compare it against an arbitrary window instead of "now" — e.g. the Bash-bypass
 *  backstop asking "did this session act *during my command's execution window*", which is a
 *  much tighter and more specific question than "is it alive within the last 30 minutes". */
export async function heartbeatSeenMs(root: string, sessionId: string): Promise<number | null> {
  try {
    const hb = JSON.parse(await readFile(heartbeatPath(root, sessionId), 'utf8')) as Heartbeat;
    const t = Date.parse(hb.seen);
    return Number.isNaN(t) ? null : t;
  } catch {
    return null;
  }
}

/** Drop a session's heartbeat (e.g. once it has released all its claims). Best-effort. */
export async function clearHeartbeat(root: string, sessionId: string): Promise<void> {
  await unlink(heartbeatPath(root, sessionId)).catch(() => {});
}
