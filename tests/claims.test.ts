import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimFile, checkFile, listClaims, releaseSession, releaseFiles } from '../src/coord/claims';
import { isSessionAlive } from '../src/coord/heartbeat';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-claims-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('coord claims (edit-gate)', () => {
  it('first session claims a file (new); a second is denied (held)', async () => {
    const root = await freshRoot();
    const now = Date.now();
    const a = await claimFile(root, 'repos/app/src/auth/session.ts', 'A', now);
    expect(a).toEqual({ ok: true, status: 'new', file: 'repos/app/src/auth/session.ts' });
    const b = await claimFile(root, 'repos/app/src/auth/session.ts', 'B', now);
    expect(b.ok).toBe(false);
    if (!b.ok) {
      expect(b.held_by).toBe('A');
      expect(b.status).toBe('held');
    }
  });

  it('the same session re-claiming renews', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'f.ts', 'A', now);
    const again = await claimFile(root, 'f.ts', 'A', now + 1000);
    expect(again).toMatchObject({ ok: true, status: 'renewed' });
  });

  it('a stale claim can be taken over', async () => {
    const root = await freshRoot();
    const t0 = Date.now();
    await claimFile(root, 'f.ts', 'A', t0, 60); // ttl 60s
    const later = await claimFile(root, 'f.ts', 'B', t0 + 120_000); // 120s later
    expect(later).toMatchObject({ ok: true, status: 'took-over' });
  });

  it('checkFile is non-mutating and reports the holder', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'f.ts', 'A', now);
    const chk = await checkFile(root, 'f.ts', 'B', now);
    expect(chk.ok).toBe(false);
    if (!chk.ok) expect(chk.held_by).toBe('A');
    // checking did not mutate — A still holds it
    const chk2 = await checkFile(root, 'f.ts', 'C', now);
    expect(chk2.ok).toBe(false);
  });

  it('releaseSession frees that session\'s claims only', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'a.ts', 'A', now);
    await claimFile(root, 'b.ts', 'A', now);
    await claimFile(root, 'c.ts', 'B', now);
    const n = await releaseSession(root, 'A');
    expect(n).toBe(2);
    const left = await listClaims(root, now);
    expect(left.map((c) => c.file)).toEqual(['c.ts']);
  });

  it('releaseFiles frees a specific file so it can be reclaimed', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'a.ts', 'A', now);
    expect(await releaseFiles(root, ['a.ts'])).toBe(1);
    const reclaim = await claimFile(root, 'a.ts', 'Z', now);
    expect(reclaim).toMatchObject({ ok: true, status: 'new' });
  });

  it('listClaims prunes stale and lists fresh', async () => {
    const root = await freshRoot();
    const t0 = Date.now();
    await claimFile(root, 'fresh.ts', 'A', t0, 3600);
    await claimFile(root, 'old.ts', 'A', t0, 60);
    const active = await listClaims(root, t0 + 120_000);
    expect(active.map((c) => c.file)).toEqual(['fresh.ts']);
  });

  describe('liveness (P1c) — a quiet-but-alive holder is not preempted at the flat TTL', () => {
    it('claimFile refuses takeover of a TTL-expired claim while the holder is active on another file', async () => {
      const root = await freshRoot();
      const t0 = Date.now();
      await claimFile(root, 'x.ts', 'A', t0, 1000); // A claims x.ts, ttl 1000s
      await claimFile(root, 'y.ts', 'A', t0 + 900_000, 1000); // A is quiet on x.ts but active on y.ts 900s later
      // x.ts's own claimed_at + ttl has now lapsed
      const attempt = await claimFile(root, 'x.ts', 'B', t0 + 1_100_000);
      expect(attempt).toMatchObject({ ok: false, status: 'held', held_by: 'A' });
    });

    it('claimFile allows takeover once the holder has gone quiet everywhere (heartbeat stale too)', async () => {
      const root = await freshRoot();
      const t0 = Date.now();
      await claimFile(root, 'x.ts', 'A', t0, 1000);
      await claimFile(root, 'y.ts', 'A', t0 + 900_000, 1000); // A's last sign of life
      const attempt = await claimFile(root, 'x.ts', 'B', t0 + 900_000 + 1_100_000);
      expect(attempt).toMatchObject({ ok: true, status: 'took-over' });
    });

    it('checkFile mirrors the liveness rule and stays non-mutating', async () => {
      const root = await freshRoot();
      const t0 = Date.now();
      await claimFile(root, 'x.ts', 'A', t0, 1000);
      await claimFile(root, 'y.ts', 'A', t0 + 900_000, 1000);
      const chk = await checkFile(root, 'x.ts', 'B', t0 + 1_100_000);
      expect(chk).toMatchObject({ ok: false, status: 'held', held_by: 'A' });
      const again = await checkFile(root, 'x.ts', 'C', t0 + 1_100_000);
      expect(again).toMatchObject({ ok: false, status: 'held', held_by: 'A' });
    });

    it('listClaims keeps a TTL-expired claim listed while its holder is active elsewhere', async () => {
      const root = await freshRoot();
      const t0 = Date.now();
      await claimFile(root, 'x.ts', 'A', t0, 1000);
      await claimFile(root, 'y.ts', 'A', t0 + 900_000, 1000);
      const active = await listClaims(root, t0 + 1_100_000);
      expect(active.map((c) => c.file).sort()).toEqual(['x.ts', 'y.ts']);
    });

    it('a session with no further activity is still preempted at TTL (crash path unaffected)', async () => {
      const root = await freshRoot();
      const t0 = Date.now();
      await claimFile(root, 'f.ts', 'A', t0, 60); // ttl 60s, A never touches anything again
      const later = await claimFile(root, 'f.ts', 'B', t0 + 120_000);
      expect(later).toMatchObject({ ok: true, status: 'took-over' });
    });

    it('releaseSession clears its heartbeat too — no orphan liveness record left protecting nothing', async () => {
      const root = await freshRoot();
      const t0 = Date.now();
      await claimFile(root, 'f.ts', 'A', t0);
      expect(await isSessionAlive(root, 'A', t0, 3_600_000)).toBe(true);
      await releaseSession(root, 'A');
      expect(await isSessionAlive(root, 'A', t0, 3_600_000)).toBe(false);
    });
  });
});
