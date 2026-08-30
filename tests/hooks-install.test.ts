import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHookEntries, buildPostHookEntries, buildSessionEntry, mergeSettings, hooksInstall, ensureStoreIgnored } from '../src/commands/hooks';

const MANIFEST = `[workspace]
name = "demo"

[[repos]]
name = "app"
url = "https://example.com/app.git"
path = "app"
ref = "main"
`;

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-hooks-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('buildHookEntries / buildPostHookEntries / buildSessionEntry / mergeSettings', () => {
  it('builds the four PreToolUse entries with the given prefix', () => {
    const entries = buildHookEntries('repolith');
    expect(entries.map((e) => e.matcher)).toEqual(['ExitPlanMode', 'Edit', 'Write', 'Bash']);
    expect(entries[0].hooks[0].command).toBe('repolith plan-hook');
    expect(entries[1].hooks[0].command).toBe('repolith edit-hook');
    expect(entries[2].hooks[0].command).toBe('repolith edit-hook');
    expect(entries[3].hooks[0].command).toBe('repolith bash-pre-hook');
  });

  it('builds the three PostToolUse entries with the given prefix', () => {
    const entries = buildPostHookEntries('repolith');
    expect(entries.map((e) => e.matcher)).toEqual(['Bash', 'Edit', 'Write']);
    expect(entries[0].hooks[0].command).toBe('repolith bash-post-hook');
    expect(entries[1].hooks[0].command).toBe('repolith spec-hook');
    expect(entries[2].hooks[0].command).toBe('repolith spec-hook');
  });

  it('builds the SessionStart entry with the given prefix', () => {
    const entry = buildSessionEntry('repolith');
    expect(entry.matcher).toBe('*');
    expect(entry.hooks[0].command).toBe('repolith session-hook');
  });

  it('adds all eight hooks (PreToolUse × 4 + PostToolUse × 3 + SessionStart) to empty settings', () => {
    const { settings, added } = mergeSettings({}, 'repolith');
    expect(added).toHaveLength(8);
    expect((settings.hooks as any).PreToolUse).toHaveLength(4);
    expect((settings.hooks as any).PostToolUse).toHaveLength(3);
    expect((settings.hooks as any).PostToolUse[0].hooks[0].command).toBe('repolith bash-post-hook');
    expect((settings.hooks as any).PostToolUse[1].hooks[0].command).toBe('repolith spec-hook');
    expect((settings.hooks as any).SessionStart).toHaveLength(1);
    expect((settings.hooks as any).SessionStart[0].hooks[0].command).toBe('repolith session-hook');
  });

  it('is idempotent — second merge adds nothing', () => {
    const first = mergeSettings({}, 'repolith');
    const second = mergeSettings(first.settings, 'repolith');
    expect(second.added).toHaveLength(0);
    expect((second.settings.hooks as any).PreToolUse).toHaveLength(4);
    expect((second.settings.hooks as any).PostToolUse).toHaveLength(3);
    expect((second.settings.hooks as any).SessionStart).toHaveLength(1);
  });

  it('preserves unrelated settings and pre-existing PreToolUse hooks', () => {
    const existing = {
      model: 'opus',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
    };
    const { settings, added } = mergeSettings(existing, 'repolith');
    expect(settings.model).toBe('opus');
    expect(added).toHaveLength(8); // 4 PreToolUse + 3 PostToolUse + 1 SessionStart
    const pre = (settings.hooks as any).PreToolUse;
    expect(pre).toHaveLength(5); // the foreign Bash one + the four repolith ones
    expect(pre[0].matcher).toBe('Bash');
    expect((settings.hooks as any).PostToolUse).toHaveLength(3);
    expect((settings.hooks as any).SessionStart).toHaveLength(1);
  });

  it('does not duplicate when a matching repolith entry already exists', () => {
    const existing = {
      hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'bun run x/src/cli.ts edit-hook' }] }] },
    };
    const { added } = mergeSettings(existing, 'repolith');
    // PreToolUse Edit→edit-hook already present → skipped; the PostToolUse Edit→spec-hook
    // still lands (different event list, different subcommand).
    expect(added.map((a) => a.split(' ')[0]).sort()).toEqual([
      'Bash', 'Bash', 'Edit', 'ExitPlanMode', 'SessionStart', 'Write', 'Write',
    ]);
  });
});

describe('hooksInstall (integration)', () => {
  const prevBin = process.env.REPOLITH_BIN;
  afterAll(() => {
    if (prevBin === undefined) delete process.env.REPOLITH_BIN;
    else process.env.REPOLITH_BIN = prevBin;
  });

  it('writes settings.json and the per-repo post-commit, idempotently', async () => {
    process.env.REPOLITH_BIN = 'repolith'; // make the written command deterministic
    const root = await freshRoot();
    await writeFile(join(root, 'repolith.toml'), MANIFEST, 'utf8');
    await mkdir(join(root, 'app', '.git', 'hooks'), { recursive: true });

    await hooksInstall({ manifest: join(root, 'repolith.toml'), postCommit: true });

    const settings = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
    expect(settings.hooks.PreToolUse).toHaveLength(4);
    expect(settings.hooks.PreToolUse[0].hooks[0].command).toBe('repolith plan-hook');
    expect(settings.hooks.PostToolUse).toHaveLength(3);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toBe('repolith bash-post-hook');
    expect(settings.hooks.PostToolUse[1].hooks[0].command).toBe('repolith spec-hook');
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe('repolith session-hook');

    const postCommit = await readFile(join(root, 'app', '.git', 'hooks', 'post-commit'), 'utf8');
    expect(postCommit).toContain('repolith claim release --committed');

    // Re-run → still exactly four PreToolUse + three PostToolUse + one SessionStart, no duplication.
    await hooksInstall({ manifest: join(root, 'repolith.toml'), postCommit: true });
    const again = JSON.parse(await readFile(join(root, '.claude', 'settings.json'), 'utf8'));
    expect(again.hooks.PreToolUse).toHaveLength(4);
    expect(again.hooks.PostToolUse).toHaveLength(3);
    expect(again.hooks.SessionStart).toHaveLength(1);
  });

  it('--print changes nothing on disk', async () => {
    process.env.REPOLITH_BIN = 'repolith';
    const root = await freshRoot();
    await writeFile(join(root, 'repolith.toml'), MANIFEST, 'utf8');

    await hooksInstall({ manifest: join(root, 'repolith.toml'), print: true });

    // No .claude/settings.json should have been created.
    let created = true;
    try {
      await readFile(join(root, '.claude', 'settings.json'), 'utf8');
    } catch {
      created = false;
    }
    expect(created).toBe(false);
  });

  it('does not clobber an existing foreign post-commit hook', async () => {
    process.env.REPOLITH_BIN = 'repolith';
    const root = await freshRoot();
    await writeFile(join(root, 'repolith.toml'), MANIFEST, 'utf8');
    const hookPath = join(root, 'app', '.git', 'hooks', 'post-commit');
    await mkdir(join(root, 'app', '.git', 'hooks'), { recursive: true });
    await writeFile(hookPath, '#!/bin/sh\necho existing\n', 'utf8');

    await hooksInstall({ manifest: join(root, 'repolith.toml'), postCommit: true });

    const after = await readFile(hookPath, 'utf8');
    expect(after).toBe('#!/bin/sh\necho existing\n'); // untouched
  });
});

// Finding 9: `.repolith/` must never be committable from a workspace root that is
// itself a git repo — that is exactly how the original store leak happened.
describe('ensureStoreIgnored', () => {
  it('does nothing when the workspace root is not a git repo', async () => {
    const root = await freshRoot();
    expect(await ensureStoreIgnored(root)).toBeNull();
    let exists = true;
    try {
      await readFile(join(root, '.gitignore'), 'utf8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false); // no .gitignore invented for a non-repo
  });

  it('creates .gitignore with .repolith/ when the root is a repo without one', async () => {
    const root = await freshRoot();
    await mkdir(join(root, '.git'), { recursive: true });
    expect(await ensureStoreIgnored(root)).toBe(join(root, '.gitignore'));
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('.repolith/\n');
  });

  it('appends to an existing .gitignore, preserving its content', async () => {
    const root = await freshRoot();
    await mkdir(join(root, '.git'), { recursive: true });
    await writeFile(join(root, '.gitignore'), 'node_modules/\ndist', 'utf8'); // no trailing newline
    await ensureStoreIgnored(root);
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe('node_modules/\ndist\n.repolith/\n');
  });

  it('is idempotent — every spelling of the entry counts as present', async () => {
    for (const spelling of ['.repolith/', '.repolith', '/.repolith/', '/.repolith']) {
      const root = await freshRoot();
      await mkdir(join(root, '.git'), { recursive: true });
      await writeFile(join(root, '.gitignore'), `${spelling}\n`, 'utf8');
      expect(await ensureStoreIgnored(root)).toBeNull();
      expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(`${spelling}\n`); // untouched
    }
  });

  it('print mode reports the path but writes nothing', async () => {
    const root = await freshRoot();
    await mkdir(join(root, '.git'), { recursive: true });
    expect(await ensureStoreIgnored(root, true)).toBe(join(root, '.gitignore'));
    let exists = true;
    try {
      await readFile(join(root, '.gitignore'), 'utf8');
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('hooksInstall wires the guard in for a repo-rooted workspace', async () => {
    process.env.REPOLITH_BIN = 'repolith';
    const root = await freshRoot();
    await writeFile(join(root, 'repolith.toml'), MANIFEST, 'utf8');
    await mkdir(join(root, '.git'), { recursive: true });
    await hooksInstall({ manifest: join(root, 'repolith.toml') });
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.repolith/');
  });
});
