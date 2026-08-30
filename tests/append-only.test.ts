import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isAppendOnlyFile } from '../src/coord/appendOnly';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-appendonly-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('isAppendOnlyFile', () => {
  it('matches the built-in default (SESSION_LOG.md) with no manifest at all', async () => {
    const root = await freshRoot();
    expect(await isAppendOnlyFile(root, 'brain-platform/SESSION_LOG.md')).toBe(true);
    expect(await isAppendOnlyFile(root, 'nested/dir/SESSION_LOG.md')).toBe(true);
  });

  it('does not match an ordinary source file', async () => {
    const root = await freshRoot();
    expect(await isAppendOnlyFile(root, 'src/auth/session.ts')).toBe(false);
  });

  it('matches basenames added via [coord] append_only in repolith.toml', async () => {
    const root = await freshRoot();
    await writeFile(
      join(root, 'repolith.toml'),
      `[workspace]\nname = "ws"\n[[repos]]\nname = "a"\nurl = "u"\npath = "p"\nref = "r"\n[coord]\nappend_only = ["CHANGELOG.md"]\n`,
      'utf8',
    );
    expect(await isAppendOnlyFile(root, 'repo/CHANGELOG.md')).toBe(true);
    expect(await isAppendOnlyFile(root, 'repo/SESSION_LOG.md')).toBe(true); // default still applies
    expect(await isAppendOnlyFile(root, 'repo/other.md')).toBe(false);
  });

  it('falls back to the default list when repolith.toml is malformed (never throws)', async () => {
    const root = await freshRoot();
    await writeFile(join(root, 'repolith.toml'), 'not valid toml [[[', 'utf8');
    expect(await isAppendOnlyFile(root, 'repo/SESSION_LOG.md')).toBe(true);
    expect(await isAppendOnlyFile(root, 'repo/other.md')).toBe(false);
  });
});
