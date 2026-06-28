import { describe, it, expect } from 'bun:test';
import { runAll } from '../src/runner';
import type { RepoEntry } from '../src/types';

const REPOS: RepoEntry[] = [
  { name: 'a', url: 'u', path: 'p', ref: 'main' },
  { name: 'b', url: 'u', path: 'p', ref: 'main' },
  { name: 'c', url: 'u', path: 'p', ref: 'main' },
];

describe('runAll', () => {
  it('returns a result for every repo', async () => {
    const results = await runAll(REPOS, async (r) => r.name.toUpperCase());
    expect(results).toHaveLength(3);
  });

  it('captures success values', async () => {
    const results = await runAll(REPOS, async (r) => r.name + '!');
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(r.repo.name + '!');
    }
  });

  it('captures errors without throwing', async () => {
    const results = await runAll(REPOS, async (r) => {
      if (r.name === 'b') throw new Error('boom');
      return r.name;
    });
    const b = results.find(r => r.repo.name === 'b')!;
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.message).toBe('boom');
    // others still succeed
    expect(results.filter(r => r.ok)).toHaveLength(2);
  });

  it('respects concurrency cap', async () => {
    let active = 0;
    let maxActive = 0;
    const many = Array.from({ length: 10 }, (_, i) => ({
      name: String(i), url: '', path: '', ref: 'main',
    }));
    await runAll(many, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    }, 3);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
