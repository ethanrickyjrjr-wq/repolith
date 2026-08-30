import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { gitFileState, assessStaleness, DEFAULT_IDLE_GRACE_MS } from '../src/coord/staleness';
import type { Claim } from '../src/coord/claims';
import type { WorkspaceManifest } from '../src/types';

const MANIFEST: WorkspaceManifest = { name: 'demo', repos: [{ name: 'app', url: 'https://example.com/app.git', path: 'app', ref: 'main' }] };

const roots: string[] = [];
async function freshWs(): Promise<{ root: string; app: string }> {
  const root = await mkdtemp(join(tmpdir(), 'repolith-stale-'));
  roots.push(root);
  const app = join(root, 'app');
  await mkdir(join(app, 'src'), { recursive: true });
  await execa('git', ['init', '-q'], { cwd: app });
  await execa('git', ['config', 'user.email', 'd@e.com'], { cwd: app });
  await execa('git', ['config', 'user.name', 'D'], { cwd: app });
  return { root, app };
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

function claim(file: string, claimedAtIso: string, sessionId = 'A'): Claim {
  return { file, session_id: sessionId, claimed_at: claimedAtIso, ttl_sec: 1800 };
}

describe('gitFileState (real git)', () => {
  it('a committed, untouched file reports clean with its commit time', async () => {
    const { root, app } = await freshWs();
    await writeFile(join(app, 'src', 'foo.ts'), 'export const x = 1;\n', 'utf8');
    await execa('git', ['add', '-A'], { cwd: app });
    await execa('git', ['commit', '-qm', 'add foo'], { cwd: app });

    const state = await gitFileState(root, MANIFEST, 'app/src/foo.ts');
    expect(state?.clean).toBe(true);
    expect(state?.lastCommitAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(state!.lastCommitAt!))).toBe(false);
  });

  it('a file with uncommitted edits reports dirty', async () => {
    const { root, app } = await freshWs();
    await writeFile(join(app, 'src', 'foo.ts'), 'export const x = 1;\n', 'utf8');
    await execa('git', ['add', '-A'], { cwd: app });
    await execa('git', ['commit', '-qm', 'add foo'], { cwd: app });
    await writeFile(join(app, 'src', 'foo.ts'), 'export const x = 2;\n', 'utf8'); // dirty it again

    const state = await gitFileState(root, MANIFEST, 'app/src/foo.ts');
    expect(state?.clean).toBe(false);
  });

  it('a never-committed, never-created file has no commit and reads as clean (nothing to report)', async () => {
    const { root, app } = await freshWs();
    // The repo needs at least one commit: `git log` exits 128 in a repo with NO commits at all,
    // which gitFileState (correctly) catches as "cannot assess" — a different branch than the
    // one under test here. Commit an unrelated file so history exists, then ask about a path
    // that has none of its own.
    await writeFile(join(app, 'src', 'other.ts'), 'export const y = 1;\n', 'utf8');
    await execa('git', ['add', '-A'], { cwd: app });
    await execa('git', ['commit', '-qm', 'add other'], { cwd: app });

    const state = await gitFileState(root, MANIFEST, 'app/src/never-existed.ts');
    expect(state).toEqual({ clean: true, lastCommitAt: null });
  });

  it('a repo with no commits at all cannot be assessed (git log exits non-zero, never read as clean)', async () => {
    const { root } = await freshWs(); // `git init` only — zero commits
    const state = await gitFileState(root, MANIFEST, 'app/src/foo.ts');
    expect(state).toBeNull();
  });

  it('a gitignored file under live edit cannot be assessed — status hides it, so never flag it', async () => {
    const { root, app } = await freshWs();
    await writeFile(join(app, '.gitignore'), 'secrets.local.md\n', 'utf8');
    await execa('git', ['add', '-A'], { cwd: app });
    await execa('git', ['commit', '-qm', 'ignore secrets'], { cwd: app });
    await writeFile(join(app, 'secrets.local.md'), 'actively being written\n', 'utf8');

    // `git status --porcelain -- secrets.local.md` prints nothing here: without the
    // check-ignore guard this would read {clean:true,lastCommitAt:null} → idle-clean → a
    // flag against a claim that is protecting real, in-progress work.
    const state = await gitFileState(root, MANIFEST, 'app/secrets.local.md');
    expect(state).toBeNull();
  });

  it('a TRACKED file later added to .gitignore is still assessed (check-ignore is index-aware)', async () => {
    const { root, app } = await freshWs();
    await writeFile(join(app, 'src', 'foo.ts'), 'export const x = 1;\n', 'utf8');
    await writeFile(join(app, '.gitignore'), 'src/foo.ts\n', 'utf8');
    await execa('git', ['add', '-A', '-f'], { cwd: app });
    await execa('git', ['commit', '-qm', 'track foo despite ignore'], { cwd: app });

    const state = await gitFileState(root, MANIFEST, 'app/src/foo.ts');
    expect(state?.clean).toBe(true);
    expect(state?.lastCommitAt).not.toBeNull();
  });

  it('a path outside every manifest repo cannot be assessed', async () => {
    const { root } = await freshWs();
    const state = await gitFileState(root, MANIFEST, 'not-a-repo/foo.ts');
    expect(state).toBeNull();
  });

  it('a repo directory that is not yet a git repo cannot be assessed (never treated as clean)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repolith-stale-'));
    roots.push(root);
    await mkdir(join(root, 'app'), { recursive: true }); // no `git init` — repo not cloned yet
    const state = await gitFileState(root, MANIFEST, 'app/src/foo.ts');
    expect(state).toBeNull();
  });
});

describe('assessStaleness — pure decision logic (injected fetcher)', () => {
  const t0 = Date.parse('2026-08-12T16:00:00.000Z');

  it('a dirty file is never stale, no matter how old the claim is', async () => {
    const c = claim('app/f.ts', new Date(t0 - 3_600_000).toISOString());
    const verdict = await assessStaleness('/root', MANIFEST, c, t0, {
      fetchState: async () => ({ clean: false, lastCommitAt: null }),
    });
    expect(verdict).toEqual({ stale: false });
  });

  it('clean-since-commit: a commit landed at or after claimed_at → auto-release grade', async () => {
    const claimedAt = new Date(t0 - 25 * 60_000).toISOString(); // claimed 25 min ago
    const committedAt = new Date(t0 - 24 * 60_000).toISOString(); // committed 24 min ago (after claim)
    const c = claim('app/f.ts', claimedAt);
    const verdict = await assessStaleness('/root', MANIFEST, c, t0, {
      fetchState: async () => ({ clean: true, lastCommitAt: committedAt }),
    });
    expect(verdict).toEqual({ stale: true, reason: 'clean-since-commit', committedAt });
  });

  it('a commit landing at the exact same instant as claimed_at still counts (>=, not >)', async () => {
    const claimedAt = new Date(t0 - 60_000).toISOString();
    const c = claim('app/f.ts', claimedAt);
    const verdict = await assessStaleness('/root', MANIFEST, c, t0, {
      fetchState: async () => ({ clean: true, lastCommitAt: claimedAt }),
    });
    expect(verdict).toMatchObject({ stale: true, reason: 'clean-since-commit' });
  });

  it('idle-clean: clean, last commit predates the claim, and the claim is older than the grace window', async () => {
    const claimedAt = new Date(t0 - DEFAULT_IDLE_GRACE_MS - 1000).toISOString();
    const olderCommit = new Date(t0 - DEFAULT_IDLE_GRACE_MS - 60_000).toISOString();
    const c = claim('app/f.ts', claimedAt);
    const verdict = await assessStaleness('/root', MANIFEST, c, t0, {
      fetchState: async () => ({ clean: true, lastCommitAt: olderCommit }),
    });
    expect(verdict).toMatchObject({ stale: true, reason: 'idle-clean' });
  });

  it('idle-clean also fires for a file with NO commits at all, once the grace window passes', async () => {
    const claimedAt = new Date(t0 - DEFAULT_IDLE_GRACE_MS - 1000).toISOString();
    const c = claim('app/f.ts', claimedAt);
    const verdict = await assessStaleness('/root', MANIFEST, c, t0, {
      fetchState: async () => ({ clean: true, lastCommitAt: null }),
    });
    expect(verdict).toMatchObject({ stale: true, reason: 'idle-clean' });
  });

  it('a claim taken moments ago, clean with no newer commit, is NOT flagged before the grace window', async () => {
    const claimedAt = new Date(t0 - 5000).toISOString(); // claimed 5s ago — well under the grace window
    const c = claim('app/f.ts', claimedAt);
    const verdict = await assessStaleness('/root', MANIFEST, c, t0, {
      fetchState: async () => ({ clean: true, lastCommitAt: null }),
    });
    expect(verdict).toEqual({ stale: false });
  });

  it('a custom idleGraceMs is honored', async () => {
    const claimedAt = new Date(t0 - 30_000).toISOString(); // 30s old
    const c = claim('app/f.ts', claimedAt);
    const short = await assessStaleness('/root', MANIFEST, c, t0, {
      idleGraceMs: 10_000,
      fetchState: async () => ({ clean: true, lastCommitAt: null }),
    });
    expect(short).toMatchObject({ stale: true, reason: 'idle-clean' });
  });

  it('fetchState returning null (cannot assess) is never treated as stale', async () => {
    const c = claim('app/f.ts', new Date(t0 - 3_600_000).toISOString());
    const verdict = await assessStaleness('/root', MANIFEST, c, t0, { fetchState: async () => null });
    expect(verdict).toEqual({ stale: false });
  });

  it('reproduces the actual incident: claimed at T, committed 1 min later, 24 min clean since', async () => {
    const claimedAt = new Date(t0 - 25 * 60_000).toISOString();
    const committedAt = new Date(t0 - 24 * 60_000).toISOString();
    const c = claim('brain-platform/_ASSISTANT/STRIKES.md', claimedAt, '9db5b8a2-4aba-4507-9214-cc62c7f96243');
    const verdict = await assessStaleness('/root', MANIFEST, c, t0, {
      fetchState: async () => ({ clean: true, lastCommitAt: committedAt }),
    });
    expect(verdict).toMatchObject({ stale: true, reason: 'clean-since-commit', committedAt });
  });
});
