import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePlan, listActive, clearPlan, type SessionPlan } from '../src/coord/store';

function mk(id: string, updatedIso: string, ttl = 3600): SessionPlan {
  return {
    session_id: id,
    workspace: 'ws',
    summary: id,
    areas: [`src/${id}/**`],
    status: 'planning',
    started_at: updatedIso,
    updated_at: updatedIso,
    ttl_sec: ttl,
  };
}

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-store-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('coord store', () => {
  it('write then list round-trips', async () => {
    const root = await freshRoot();
    const now = Date.parse('2026-06-28T12:00:00.000Z');
    await writePlan(root, mk('a', new Date(now).toISOString()));
    const active = await listActive(root, now + 1000);
    expect(active).toHaveLength(1);
    expect(active[0].session_id).toBe('a');
    expect(active[0].areas).toEqual(['src/a/**']);
  });

  it('prunes stale sessions past their ttl', async () => {
    const root = await freshRoot();
    const old = Date.parse('2026-06-28T00:00:00.000Z');
    await writePlan(root, mk('old', new Date(old).toISOString(), 60));
    const active = await listActive(root, old + 120_000); // 120s later, ttl 60s
    expect(active).toHaveLength(0);
  });

  it('missing store → []', async () => {
    const root = await freshRoot();
    expect(await listActive(root, Date.now())).toEqual([]);
  });

  it('skips corrupt files', async () => {
    const root = await freshRoot();
    await mkdir(join(root, '.repolith', 'sessions'), { recursive: true });
    await writeFile(join(root, '.repolith', 'sessions', 'bad.json'), '{not valid json', 'utf8');
    expect(await listActive(root, Date.now())).toEqual([]);
  });

  it('clearPlan removes a session', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await writePlan(root, mk('x', new Date(now).toISOString()));
    await clearPlan(root, 'x');
    expect(await listActive(root, now + 1000)).toEqual([]);
  });
});
