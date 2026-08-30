import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimFile, releaseFiles } from '../src/coord/claims';
import { headOfLine, cycleFrom, cycleMembers, deadlockSurvivor, waitForClaim, type WaitEdge } from '../src/coord/waits';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-fair-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const NOW = Date.parse('2026-06-28T12:00:10.000Z');
const FRESH = '2026-06-28T12:00:09.900Z'; // live waiters refresh `seen` every poll
const edge = (id: string, file: string, since: string, seen = FRESH): WaitEdge => ({
  session_id: id,
  file,
  held_by: 'H',
  since,
  seen,
});

describe('headOfLine (FIFO fairness)', () => {
  it('the longest-waiting (smallest since) waiter is head', () => {
    const es = [edge('B', 'x', '2026-06-28T12:00:05.000Z'), edge('A', 'x', '2026-06-28T12:00:01.000Z')];
    expect(headOfLine(es, 'x', 'A', NOW)).toBe(true);
    expect(headOfLine(es, 'x', 'B', NOW)).toBe(false);
  });

  it('ties break deterministically by session_id', () => {
    const t = '2026-06-28T12:00:01.000Z';
    const es = [edge('B', 'x', t), edge('A', 'x', t)];
    expect(headOfLine(es, 'x', 'A', NOW)).toBe(true);
    expect(headOfLine(es, 'x', 'B', NOW)).toBe(false);
  });

  it('only considers waiters on the same file', () => {
    const es = [edge('A', 'y', '2026-06-28T12:00:00.000Z'), edge('B', 'x', '2026-06-28T12:00:05.000Z')];
    expect(headOfLine(es, 'x', 'B', NOW)).toBe(true); // A waits on y, doesn't gate x
  });

  it('skips a crashed (stale-seen) head so the next waiter promotes itself', () => {
    const es = [
      edge('A', 'x', '2026-06-28T12:00:00.000Z', '2026-06-28T11:50:00.000Z'), // older but seen 10min ago
      edge('B', 'x', '2026-06-28T12:00:05.000Z', '2026-06-28T12:00:09.500Z'), // fresh
    ];
    expect(headOfLine(es, 'x', 'B', NOW, 20)).toBe(true);
    expect(headOfLine(es, 'x', 'A', NOW, 20)).toBe(false);
  });
});

describe('cycleFrom (deadlock graph integrity)', () => {
  it('detects an A↔B cycle even with a non-head third waiter C in the graph', () => {
    const m = new Map<string, string>([
      ['A', 'B'],
      ['B', 'A'],
      ['C', 'A'], // C waits behind the deadlock, not part of it
    ]);
    expect(cycleFrom(m, 'A')).toBe(true);
    expect(cycleFrom(m, 'B')).toBe(true);
    expect(cycleFrom(m, 'C')).toBe(false);
  });

  it('no false cycle on a non-looping chain', () => {
    expect(cycleFrom(new Map([['A', 'B'], ['B', 'C']]), 'A')).toBe(false);
  });
});

describe('cycleMembers (deadlock ring membership)', () => {
  it('returns both members of a 2-cycle, from either start', () => {
    const m = new Map<string, string>([['A', 'B'], ['B', 'A']]);
    expect(new Set(cycleMembers(m, 'A'))).toEqual(new Set(['A', 'B']));
    expect(new Set(cycleMembers(m, 'B'))).toEqual(new Set(['A', 'B']));
  });

  it('returns all three members of a 3-cycle, from any start', () => {
    const m = new Map<string, string>([['A', 'B'], ['B', 'C'], ['C', 'A']]);
    for (const s of ['A', 'B', 'C']) {
      expect(new Set(cycleMembers(m, s))).toEqual(new Set(['A', 'B', 'C']));
    }
  });

  it('returns null for a non-looping chain', () => {
    expect(cycleMembers(new Map([['A', 'B'], ['B', 'C']]), 'A')).toBeNull();
  });

  it('returns null when the cycle does not include start', () => {
    const m = new Map<string, string>([['A', 'B'], ['B', 'A'], ['C', 'A']]); // C hangs off the A↔B ring
    expect(cycleMembers(m, 'C')).toBeNull();
  });
});

describe('deadlockSurvivor (deterministic election)', () => {
  const e = (id: string, since: string): WaitEdge => edge(id, 'f', since);

  it('elects the longest-waiting member (smallest since)', () => {
    const es = [e('A', '2026-06-28T12:00:05.000Z'), e('B', '2026-06-28T12:00:01.000Z')];
    expect(deadlockSurvivor(['A', 'B'], es)).toBe('B'); // B has waited longer
  });

  it('breaks ties by session_id', () => {
    const t = '2026-06-28T12:00:01.000Z';
    expect(deadlockSurvivor(['A', 'B'], [e('A', t), e('B', t)])).toBe('A');
  });

  it('every member elects the same survivor regardless of member-list order', () => {
    const es = [
      e('A', '2026-06-28T12:00:03.000Z'),
      e('B', '2026-06-28T12:00:01.000Z'),
      e('C', '2026-06-28T12:00:02.000Z'),
    ];
    expect(deadlockSurvivor(['A', 'B', 'C'], es)).toBe('B');
    expect(deadlockSurvivor(['C', 'A', 'B'], es)).toBe('B'); // rotated → same winner
    expect(deadlockSurvivor(['B', 'C', 'A'], es)).toBe('B');
  });
});

describe('waitForClaim — non-head deadlock member still detected (observe vs acquire)', () => {
  it('A↔B deadlock is detected even though B is a NON-head waiter on the contested file', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'X.ts', 'A', now); // A holds X, will wait on Y
    await claimFile(root, 'Y.ts', 'B', now); // B holds Y, will wait on X

    // C starts waiting on X first → C is head of X, so B becomes a NON-head waiter on X.
    // If non-heads didn't observe (refresh held_by), B's edge would go stale and the
    // A↔B cycle would be missed. This guards exactly that.
    const cP = waitForClaim(root, 'X.ts', 'C', { pollMs: 15, timeoutMs: 600 });
    await new Promise((r) => setTimeout(r, 40)); // let C register the older `since`
    const aP = waitForClaim(root, 'Y.ts', 'A', { pollMs: 15, timeoutMs: 600 });
    const bP = waitForClaim(root, 'X.ts', 'B', { pollMs: 15, timeoutMs: 600 });

    const [a, b, c] = await Promise.all([aP, bP, cP]);
    // The A↔B cycle is still DETECTED from B's non-head edge — the guard's point. If
    // B's edge went stale and the cycle were missed, neither a nor b would yield
    // (count 0). Exactly one yields now; the other is the elected survivor (which
    // times out here, since neither A nor B releases).
    expect([a, b].filter((r) => r.reason === 'deadlock').length).toBe(1);
    expect(c.reason).toBe('timeout'); // C waits behind the deadlock, not in it
  });

  it('a newcomer does not jump an already-waiting queue (fast-path respects FIFO)', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'x.ts', 'A', now); // A holds X
    const bP = waitForClaim(root, 'x.ts', 'B', { pollMs: 15, timeoutMs: 3000 }); // B queues first
    await new Promise((r) => setTimeout(r, 45)); // B registers + becomes head
    await releaseFiles(root, ['x.ts']); // X is momentarily free
    await new Promise((r) => setTimeout(r, 5)); // newcomer C arrives in the window
    const cP = waitForClaim(root, 'x.ts', 'C', { pollMs: 15, timeoutMs: 250 });

    const [b, c] = await Promise.all([bP, cP]);
    expect(b.acquired).toBe(true); // the longest-waiting waiter wins the free file
    expect(c.acquired).toBe(false); // the newcomer is queued behind B (who now holds it) → times out
    expect(c.reason).toBe('timeout');
  });
});

describe('waitForClaim — deadlock election leaves exactly one survivor', () => {
  it('2-cycle: one member yields, one survives', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'X.ts', 'A', now); // A holds X, waits on Y
    await claimFile(root, 'Y.ts', 'B', now); // B holds Y, waits on X
    const aP = waitForClaim(root, 'Y.ts', 'A', { pollMs: 15, timeoutMs: 600 });
    const bP = waitForClaim(root, 'X.ts', 'B', { pollMs: 15, timeoutMs: 600 });
    const [a, b] = await Promise.all([aP, bP]);
    expect([a, b].filter((r) => r.reason === 'deadlock').length).toBe(1); // exactly one yields
    expect([a, b].filter((r) => r.reason !== 'deadlock').length).toBe(1); // the survivor (times out here)
  });

  it('3-cycle (A→B→C→A): two members yield, one survives', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'X.ts', 'A', now); // A holds X, waits on Y
    await claimFile(root, 'Y.ts', 'B', now); // B holds Y, waits on Z
    await claimFile(root, 'Z.ts', 'C', now); // C holds Z, waits on X
    const aP = waitForClaim(root, 'Y.ts', 'A', { pollMs: 15, timeoutMs: 1500 });
    const bP = waitForClaim(root, 'Z.ts', 'B', { pollMs: 15, timeoutMs: 1500 });
    const cP = waitForClaim(root, 'X.ts', 'C', { pollMs: 15, timeoutMs: 1500 });
    const [a, b, c] = await Promise.all([aP, bP, cP]);
    expect([a, b, c].filter((r) => r.reason === 'deadlock').length).toBe(2); // two yield
    expect([a, b, c].filter((r) => r.reason !== 'deadlock').length).toBe(1); // exactly one survives
  });

  it('the survivor ACQUIRES the instant a yielder releases the file it holds', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'X.ts', 'A', now); // A holds X, will wait on Y
    await claimFile(root, 'Y.ts', 'B', now); // B holds Y, will wait on X
    // A starts first → smaller `since` → A is the elected survivor (keeps waiting on Y).
    // B yields. When B's agent reacts by releasing the file B HOLDS (Y), A must acquire.
    const aP = waitForClaim(root, 'Y.ts', 'A', { pollMs: 15, timeoutMs: 3000 });
    await new Promise((r) => setTimeout(r, 30)); // let A register the older `since`
    const bP = waitForClaim(root, 'X.ts', 'B', { pollMs: 15, timeoutMs: 3000 });

    const b = await bP;
    expect(b.reason).toBe('deadlock'); // B lost the election and yielded
    await releaseFiles(root, ['Y.ts']); // B's agent breaks the cycle by releasing what it HELD
    const a = await aP;
    expect(a.acquired).toBe(true); // the survivor acquires the moment the held file frees
    expect(a.reason).toBe('acquired');
  });
});
