import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { writeCommitNotes } from '../src/commands/claim';
import { readNotes } from '../src/coord/journal';

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
  const root = await mkdtemp(join(tmpdir(), 'repolith-cn-'));
  roots.push(root);
  await writeFile(join(root, 'repolith.toml'), MANIFEST, 'utf8');
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

describe('writeCommitNotes (post-commit journal)', () => {
  it('writes a commit note (subject + sha) per committed file', async () => {
    const { root, app } = await freshWs();
    await writeFile(join(app, 'src', 'foo.ts'), 'export const x = 1;\n', 'utf8');
    await execa('git', ['add', '-A'], { cwd: app });
    await execa('git', ['commit', '-qm', 'tweak foo'], { cwd: app });

    await writeCommitNotes(app, root, ['app/src/foo.ts']);

    const notes = await readNotes(root, 'app/src/foo.ts');
    expect(notes).toHaveLength(1);
    expect(notes[0].kind).toBe('commit');
    expect(notes[0].msg).toBe('tweak foo');
    expect(notes[0].sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('empty file list → no notes, no throw', async () => {
    const { root, app } = await freshWs();
    await writeCommitNotes(app, root, []);
    expect(await readNotes(root, 'app/src/foo.ts')).toEqual([]);
  });
});
