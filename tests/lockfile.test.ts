import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeHash, readLockfile, writeLockfile } from '../src/lockfile';
import type { LockRepo } from '../src/types';

const REPOS: Record<string, LockRepo> = {
  frontend: { url: 'https://github.com/org/frontend.git', ref: 'main', commit: 'abc123' },
  backend:  { url: 'https://github.com/org/backend.git',  ref: 'main', commit: 'def456' },
};

describe('computeHash', () => {
  it('produces a 64-char hex string', () => {
    const h = computeHash(REPOS);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of insertion order', () => {
    const reversed: Record<string, LockRepo> = { backend: REPOS.backend, frontend: REPOS.frontend };
    expect(computeHash(REPOS)).toBe(computeHash(reversed));
  });

  it('changes when a commit changes', () => {
    const modified = { ...REPOS, frontend: { ...REPOS.frontend, commit: 'zzz' } };
    expect(computeHash(REPOS)).not.toBe(computeHash(modified));
  });
});

describe('readLockfile / writeLockfile', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ws-lock-')); });
  afterEach(async () => { await rm(dir, { recursive: true }); });

  it('returns null when lockfile is absent', async () => {
    expect(await readLockfile(dir)).toBeNull();
  });

  it('round-trips through write + read', async () => {
    const hash = computeHash(REPOS);
    const lock = { version: 1 as const, repos: REPOS, hash };
    await writeLockfile(dir, lock);
    const read = await readLockfile(dir);
    expect(read).toEqual(lock);
  });
});
