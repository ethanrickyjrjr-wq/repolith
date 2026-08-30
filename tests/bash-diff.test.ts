import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { snapshotDirty, diffDirty, readBaseline, writeBaseline, type DirtyEntry } from '../src/coord/bashDiff';
import { parseManifest } from '../src/manifest';

const MANIFEST = `[workspace]
name = "demo"

[[repos]]
name = "app"
url = "https://example.com/app.git"
path = "app"
ref = "main"
`;

const roots: string[] = [];
async function freshWs(): Promise<{ root: string; app: string }> {
  const root = await mkdtemp(join(tmpdir(), 'repolith-bashdiff-'));
  roots.push(root);
  await writeFile(join(root, 'repolith.toml'), MANIFEST, 'utf8');
  const app = join(root, 'app');
  await mkdir(app, { recursive: true });
  await execa('git', ['init', '-q'], { cwd: app });
  await execa('git', ['config', 'user.email', 'd@e.com'], { cwd: app });
  await execa('git', ['config', 'user.name', 'D'], { cwd: app });
  await writeFile(join(app, 'tracked.txt'), 'v1\n', 'utf8');
  await execa('git', ['add', '-A'], { cwd: app });
  await execa('git', ['commit', '-qm', 'init'], { cwd: app });
  return { root, app };
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('snapshotDirty', () => {
  it('is empty on a clean repo', async () => {
    const { root } = await freshWs();
    const manifest = parseManifest(MANIFEST);
    expect(await snapshotDirty(root, manifest)).toEqual([]);
  });

  it('reports an untracked file as workspace-relative with ?? status', async () => {
    const { root, app } = await freshWs();
    await writeFile(join(app, 'new.txt'), 'hi\n', 'utf8');
    const manifest = parseManifest(MANIFEST);
    const dirty = await snapshotDirty(root, manifest);
    expect(dirty).toHaveLength(1);
    expect(dirty[0].file).toBe('app/new.txt');
    expect(dirty[0].code.trim()).toBe('??');
  });

  it('reports a modified tracked file with M status', async () => {
    const { root, app } = await freshWs();
    await writeFile(join(app, 'tracked.txt'), 'v2\n', 'utf8');
    const manifest = parseManifest(MANIFEST);
    const dirty = await snapshotDirty(root, manifest);
    expect(dirty).toHaveLength(1);
    expect(dirty[0].file).toBe('app/tracked.txt');
    expect(dirty[0].code.trim()).toBe('M');
  });
});

describe('diffDirty', () => {
  it('flags a newly dirty file', () => {
    const after: DirtyEntry[] = [{ file: 'a', code: '??', mtimeMs: 1, size: 1 }];
    expect(diffDirty([], after)).toEqual(['a']);
  });

  it('flags a file that reverted from dirty to clean (the git-checkout clobber case)', () => {
    const before: DirtyEntry[] = [{ file: 'a', code: ' M', mtimeMs: 1, size: 1 }];
    expect(diffDirty(before, [])).toEqual(['a']);
  });

  it('flags a rewrite that keeps the same status code (the sed -i on an already-dirty file case)', () => {
    const before: DirtyEntry[] = [{ file: 'a', code: ' M', mtimeMs: 1, size: 10 }];
    const after: DirtyEntry[] = [{ file: 'a', code: ' M', mtimeMs: 2, size: 12 }];
    expect(diffDirty(before, after)).toEqual(['a']);
  });

  it('is silent when nothing changed', () => {
    const snap: DirtyEntry[] = [{ file: 'a', code: ' M', mtimeMs: 1, size: 10 }];
    expect(diffDirty(snap, snap)).toEqual([]);
  });

  it('only reports the files that actually differ, not the whole set', () => {
    const before: DirtyEntry[] = [{ file: 'a', code: ' M', mtimeMs: 1, size: 10 }];
    const after: DirtyEntry[] = [
      { file: 'a', code: ' M', mtimeMs: 1, size: 10 },
      { file: 'b', code: '??', mtimeMs: 5, size: 2 },
    ];
    expect(diffDirty(before, after)).toEqual(['b']);
  });
});

describe('readBaseline / writeBaseline', () => {
  it('round-trips a snapshot plus its bracket-start timestamp', async () => {
    const { root } = await freshWs();
    const entries: DirtyEntry[] = [{ file: 'app/x.ts', code: ' M', mtimeMs: 123, size: 4 }];
    await writeBaseline(root, 'session-a', 555, entries);
    expect(await readBaseline(root, 'session-a')).toEqual({ ts: 555, dirty: entries });
  });

  it('returns null when no baseline has been written for a session', async () => {
    const { root } = await freshWs();
    expect(await readBaseline(root, 'never-seen')).toBeNull();
  });

  it('keeps different sessions independent', async () => {
    const { root } = await freshWs();
    await writeBaseline(root, 'sess-1', 100, [{ file: 'a', code: '??', mtimeMs: 1, size: 1 }]);
    await writeBaseline(root, 'sess-2', 200, [{ file: 'b', code: '??', mtimeMs: 2, size: 2 }]);
    expect((await readBaseline(root, 'sess-1'))?.dirty[0].file).toBe('a');
    expect((await readBaseline(root, 'sess-2'))?.dirty[0].file).toBe('b');
  });
});
