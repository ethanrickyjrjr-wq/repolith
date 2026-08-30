import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { touchHeartbeat, isSessionAlive } from '../src/coord/heartbeat';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-heartbeat-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('coord heartbeat (P1c liveness primitive)', () => {
  it('a session with no heartbeat on record is not alive', async () => {
    const root = await freshRoot();
    expect(await isSessionAlive(root, 'ghost', Date.now(), 60_000)).toBe(false);
  });

  it('a freshly touched heartbeat is alive within the stale window', async () => {
    const root = await freshRoot();
    const t0 = Date.now();
    await touchHeartbeat(root, 'A', t0);
    expect(await isSessionAlive(root, 'A', t0 + 30_000, 60_000)).toBe(true);
  });

  it('a heartbeat older than the stale window reads as not alive', async () => {
    const root = await freshRoot();
    const t0 = Date.now();
    await touchHeartbeat(root, 'A', t0);
    expect(await isSessionAlive(root, 'A', t0 + 90_000, 60_000)).toBe(false);
  });

  it('touching again pushes the stale window forward', async () => {
    const root = await freshRoot();
    const t0 = Date.now();
    await touchHeartbeat(root, 'A', t0);
    await touchHeartbeat(root, 'A', t0 + 50_000);
    expect(await isSessionAlive(root, 'A', t0 + 90_000, 60_000)).toBe(true);
  });

  it('heartbeats are per-session — touching A does not make B alive', async () => {
    const root = await freshRoot();
    const t0 = Date.now();
    await touchHeartbeat(root, 'A', t0);
    expect(await isSessionAlive(root, 'B', t0, 60_000)).toBe(false);
  });
});
