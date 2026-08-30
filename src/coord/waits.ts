// Wait-and-acquire for serialize + auto-resume (Phase 4) with FIFO fairness (P1a).
//
// You cannot externally un-pause a Claude Code session, so "auto-resume" is the
// denied session *blocking on a poll loop*: it keeps trying to claim the file and
// the instant the holder releases it (Phase 2's post-commit `claim release
// --committed`, a TTL lapse, or an explicit release) it acquires. No external signal.
//
// Fairness (P1a): when several sessions wait on the same file, "who goes next" must
// not be a poll-timer race (that starves losers). Each waiter records a wait edge
// with a stable `since` (queue position) and a refreshed `seen` (liveness). Every
// poll, EVERY waiter *observes* (non-mutating `checkFile`) to keep its `held_by`
// current — the deadlock graph depends on that — but only the **head of line**
// (smallest `since`, tiebreak `session_id`, among waiters whose `seen` is fresh)
// escalates to an actual `claimFile`. A crashed head stops refreshing `seen` and is
// dropped, so the next waiter promotes itself instead of stalling for the full TTL.
//
// Deadlock: if A holds X and waits for Y while B holds Y and waits for X, following
// the wait edges loops back to the starting waiter. Each session waits on at most one
// file, so the wait graph is *functional* (out-degree ≤ 1): from any node there is a
// single forward path, cycles are unambiguous, and no two cycles share a node.
// `cycleMembers` returns the ring (any length); `deadlockSurvivor` then elects ONE
// member to keep waiting while the rest surface `deadlock` and yield — so only the
// minimum number of agents are disrupted, not the whole ring. The election is a pure
// function of the same edge set every member reads, and `cycleMembers` returns null for
// everyone until the whole ring is visible, so all members elect the same survivor
// without coordinating. Breaking the cycle (a yielder releasing a file it HOLDS) is the
// agents' call; the survivor acquires the instant that release lands.

import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { claimFile, checkFile, DEFAULT_CLAIM_TTL, type ClaimOutcome } from './claims.js';
import { appendWaitNote } from './journal.js';

const WAIT_EDGE_TTL_MS = 15 * 60 * 1000; // prune edges a waiter stopped refreshing (crashed)

export interface WaitEdge {
  session_id: string;
  file: string;
  held_by: string; // who holds the file ('' when the file is currently free)
  since: string; // ISO — stable queue position, set once per wait
  seen: string; // ISO — last poll, liveness heartbeat
}

const waitsDir = (root: string): string => join(root, '.repolith', 'waits');
const sanitize = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 16);
const waitPath = (root: string, sessionId: string): string => join(waitsDir(root), `${sanitize(sessionId)}.json`);
const seenMs = (e: WaitEdge): number => Date.parse(e.seen ?? e.since); // tolerate pre-`seen` edges

async function recordWait(
  root: string,
  sessionId: string,
  file: string,
  heldBy: string,
  sinceMs: number,
  nowMs: number,
): Promise<void> {
  await mkdir(waitsDir(root), { recursive: true });
  const edge: WaitEdge = {
    session_id: sessionId,
    file,
    held_by: heldBy,
    since: new Date(sinceMs).toISOString(),
    seen: new Date(nowMs).toISOString(),
  };
  await writeFile(waitPath(root, sessionId), JSON.stringify(edge, null, 2) + '\n', 'utf8');
}

async function clearWait(root: string, sessionId: string): Promise<void> {
  await unlink(waitPath(root, sessionId)).catch(() => {});
}

async function allEdges(root: string, nowMs: number): Promise<WaitEdge[]> {
  let names: string[];
  try {
    names = await readdir(waitsDir(root));
  } catch {
    return [];
  }
  const out: WaitEdge[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const p = join(waitsDir(root), name);
    try {
      const e = JSON.parse(await readFile(p, 'utf8')) as WaitEdge;
      if (nowMs - seenMs(e) > WAIT_EDGE_TTL_MS) await unlink(p).catch(() => {}); // crashed waiter → prune
      else out.push(e);
    } catch {
      /* skip corrupt */
    }
  }
  return out;
}

/** waiter session_id → the session it is blocked on (free files map to ''). */
function edgeMap(edges: WaitEdge[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of edges) m.set(e.session_id, e.held_by);
  return m;
}

/**
 * The members of the wait cycle that loops back to `start` (in traversal order),
 * or null if `start` is not in a self-returning cycle. A cycle that exists but
 * doesn't include `start` returns null. Every node has out-degree ≤ 1, so the
 * traversal is unambiguous and a missing edge (an unrecorded waiter) simply ends
 * the chain → null — which is why no member yields until the whole ring is visible.
 */
export function cycleMembers(edges: Map<string, string>, start: string): string[] | null {
  const members = [start];
  let cur = edges.get(start);
  const seen = new Set([start]);
  while (cur) {
    if (cur === start) return members; // looped back to the start → these are the ring
    if (seen.has(cur)) return null; // a cycle that doesn't involve us
    seen.add(cur);
    members.push(cur);
    cur = edges.get(cur);
  }
  return null;
}

/** Does following the wait edges from `start` loop back to `start`? (deadlock) */
export function cycleFrom(edges: Map<string, string>, start: string): boolean {
  return cycleMembers(edges, start) !== null;
}

/**
 * Elect the single cycle member that keeps waiting while the rest yield. Ordered
 * like FIFO head-of-line — longest wait (smallest `since`), tiebreak `session_id`
 * — and computed over the same edge set every member reads, so each member elects
 * the same survivor independently, no coordination needed.
 */
export function deadlockSurvivor(members: string[], edges: WaitEdge[]): string {
  const since = new Map(edges.map((e) => [e.session_id, e.since]));
  return [...members].sort(
    (a, b) => (since.get(a) ?? '').localeCompare(since.get(b) ?? '') || a.localeCompare(b),
  )[0];
}

/** Is `sessionId` the head of line for `file` — the longest-waiting live waiter? */
export function headOfLine(edges: WaitEdge[], file: string, sessionId: string, nowMs: number, pollMs = 2000): boolean {
  const stale = Math.max(3 * pollMs, 6000);
  const queue = edges
    .filter((e) => e.file === file && nowMs - seenMs(e) < stale)
    .sort((a, b) => a.since.localeCompare(b.since) || a.session_id.localeCompare(b.session_id));
  return queue.length === 0 || queue[0].session_id === sessionId;
}

export interface WaitResult {
  acquired: boolean;
  reason: 'acquired' | 'timeout' | 'deadlock';
  held_by?: string;
  waited_ms: number;
}

export interface WaitOpts {
  timeoutMs?: number;
  pollMs?: number;
  ttlSec?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Block until `file` is free (or already ours), claim it, and return. FIFO among waiters. */
export async function waitForClaim(root: string, file: string, sessionId: string, opts: WaitOpts = {}): Promise<WaitResult> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const pollMs = opts.pollMs ?? 2000;
  const ttlSec = opts.ttlSec ?? DEFAULT_CLAIM_TTL;
  const start = now();

  // Fast path: take an uncontended free file without entering the queue — BUT only
  // when no other session is already waiting on it, so a newcomer can't jump an
  // existing FIFO queue during the brief window between a release and the head's
  // next poll. If anyone's queued, fall through and let head-of-line decide.
  const queued = (await allEdges(root, start)).some((e) => e.file === file && e.session_id !== sessionId);
  if (!queued) {
    const first: ClaimOutcome = await claimFile(root, file, sessionId, now(), ttlSec);
    if (first.ok) {
      await clearWait(root, sessionId);
      return { acquired: true, reason: 'acquired', waited_ms: now() - start };
    }
  }

  let lastHeldBy: string | undefined;
  for (;;) {
    try {
      // Observe (non-mutating) so even a non-head waiter keeps its held_by fresh —
      // the deadlock graph is only correct if every waiter's edge is current.
      const obs = await checkFile(root, file, sessionId, now());
      lastHeldBy = obs.ok ? undefined : obs.held_by;
      const heldBy = lastHeldBy ?? '';
      await recordWait(root, sessionId, file, heldBy, start, now());

      const edges = await allEdges(root, now());
      const cycle = cycleMembers(edgeMap(edges), sessionId);
      if (cycle && deadlockSurvivor(cycle, edges) !== sessionId) {
        // We lost the deadlock election → yield so the survivor can proceed. Leave our
        // edge in place: every member must keep seeing the full ring to agree on the
        // same survivor until the breaking release lands. Stale edges are TTL-pruned.
        const waited_ms = now() - start;
        void appendWaitNote(root, file, sessionId, `deadlock — yielded after ${Math.round(waited_ms / 1000)}s`, new Date(now()).toISOString());
        return { acquired: false, reason: 'deadlock', held_by: lastHeldBy, waited_ms };
      }
      // No cycle, or we're the elected survivor: fall through and keep escalating as
      // head of line — we acquire the instant a yielder releases the file it holds.

      // Only the head of line escalates to a real claim → FIFO, no thundering herd.
      if (headOfLine(edges, file, sessionId, now(), pollMs)) {
        const oc = await claimFile(root, file, sessionId, now(), ttlSec);
        if (oc.ok) {
          await clearWait(root, sessionId);
          const waited_ms = now() - start;
          void appendWaitNote(root, file, sessionId, `resumed after ${Math.round(waited_ms / 1000)}s — was held by ${lastHeldBy ?? 'unknown'}`, new Date(now()).toISOString());
          return { acquired: true, reason: 'acquired', waited_ms };
        }
      }
    } catch {
      // Transient FS contention (notably on Windows: a concurrent release unlinking
      // the claim file as we read/create it) — never abort the wait; retry next poll.
    }

    if (now() - start >= timeoutMs) {
      await clearWait(root, sessionId);
      const waited_ms = now() - start;
      void appendWaitNote(root, file, sessionId, `wait timed out after ${Math.round(waited_ms / 1000)}s — held by ${lastHeldBy ?? 'unknown'}`, new Date(now()).toISOString());
      return { acquired: false, reason: 'timeout', held_by: lastHeldBy, waited_ms };
    }
    await sleep(pollMs);
  }
}

export async function listWaits(root: string, nowMs: number): Promise<WaitEdge[]> {
  return allEdges(root, nowMs);
}
