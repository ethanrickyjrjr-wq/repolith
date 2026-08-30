import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { claimBashChanges } from '../src/commands/bash';
import { snapshotDirty, type DirtyEntry } from '../src/coord/bashDiff';
import { parseManifest } from '../src/manifest';
import { claimFile, listClaims } from '../src/coord/claims';
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
  const root = await mkdtemp(join(tmpdir(), 'repolith-bashhook-'));
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

describe('claimBashChanges', () => {
  it('is a no-op when nothing changed', async () => {
    const { root } = await freshWs();
    const result = await claimBashChanges(root, 'sess-a', [], [], Date.now());
    expect(result).toEqual({ touched: [], lines: [], collided: false });
  });

  it('claims a file a Bash command created (e.g. codegen) and journals it', async () => {
    const { root, app } = await freshWs();
    const manifest = parseManifest(MANIFEST);
    const before = await snapshotDirty(root, manifest);

    await writeFile(join(app, 'generated.ts'), 'export const x = 1;\n', 'utf8');
    const after = await snapshotDirty(root, manifest);

    const now = Date.now();
    const result = await claimBashChanges(root, 'sess-a', before, after, now);
    expect(result.touched).toEqual(['app/generated.ts']);
    expect(result.collided).toBe(false);

    const claims = await listClaims(root, now);
    expect(claims).toHaveLength(1);
    expect(claims[0].file).toBe('app/generated.ts');
    expect(claims[0].session_id).toBe('sess-a');

    const notes = await readNotes(root, 'app/generated.ts');
    expect(notes.some((n) => n.kind === 'claim' && n.msg === 'editing via Bash')).toBe(true);
  });

  it('flags a real collision when the Bash command overwrote a file another session holds', async () => {
    const { root, app } = await freshWs();
    const manifest = parseManifest(MANIFEST);
    const claimedAt = Date.now();
    const bracketStart = claimedAt + 1000; // B's command starts well after A's last activity

    // Session A claimed tracked.txt before B's bracket even opened, then went quiet on it
    // (still within TTL — the claim is fresh — but its heartbeat predates B's window).
    await claimFile(root, 'app/tracked.txt', 'sess-a', claimedAt);

    // Session B's Bash command (e.g. `sed -i`) rewrites the same file.
    const before = await snapshotDirty(root, manifest);
    await writeFile(join(app, 'tracked.txt'), 'v2 from sed\n', 'utf8');
    const after = await snapshotDirty(root, manifest);

    const now = bracketStart + 500;
    const result = await claimBashChanges(root, 'sess-b', before, after, now, bracketStart);
    expect(result.touched).toEqual(['app/tracked.txt']);
    expect(result.collided).toBe(true);
    expect(result.lines.some((l) => l.includes('sess-a'))).toBe(true);

    // The original holder's claim is left intact — a reactive backstop warns, it doesn't reassign.
    const claims = await listClaims(root, now);
    expect(claims).toHaveLength(1);
    expect(claims[0].session_id).toBe('sess-a');

    const notes = await readNotes(root, 'app/tracked.txt');
    expect(notes.some((n) => n.kind === 'deny' && n.session_id === 'sess-b')).toBe(true);
  });

  it('does NOT flag a clobber when the holder was itself actively claiming files during the same bracket window (the false-positive case)', async () => {
    const { root, app } = await freshWs();
    const manifest = parseManifest(MANIFEST);
    const bracketStart = Date.now();

    // Session B's Bash command starts; bracket-start recorded, then B's (unrelated) command runs.
    const before = await snapshotDirty(root, manifest);

    // While B's command is still executing, session A saves its OWN file — this is the
    // "funnel session mid-save" scenario: A's heartbeat is touched *inside* B's window.
    const aActsAt = bracketStart + 200;
    await claimFile(root, 'app/tracked.txt', 'sess-a', aActsAt);
    await writeFile(join(app, 'tracked.txt'), 'session A own edit\n', 'utf8');

    const after = await snapshotDirty(root, manifest);
    const now = bracketStart + 500;
    const result = await claimBashChanges(root, 'sess-b', before, after, now, bracketStart);

    expect(result.touched).toEqual(['app/tracked.txt']);
    expect(result.collided).toBe(false); // not attributed to B — no urgent push, no accusation
    expect(result.lines).toEqual([]);

    // A's claim is untouched, and the journal records a soft coedit note rather than a deny.
    const claims = await listClaims(root, now);
    expect(claims).toHaveLength(1);
    expect(claims[0].session_id).toBe('sess-a');

    const notes = await readNotes(root, 'app/tracked.txt');
    expect(notes.some((n) => n.kind === 'coedit' && n.session_id === 'sess-b' && n.msg.includes('not attributed'))).toBe(true);
    expect(notes.some((n) => n.kind === 'deny')).toBe(false);
  });

  it('never gates an append-only file, even when another session holds a claim on it', async () => {
    const { root, app } = await freshWs();
    const manifest = parseManifest(MANIFEST);
    const now = Date.now();

    // Session A holds a claim on the shared log (e.g. from a prior Edit-tool touch).
    await claimFile(root, 'app/SESSION_LOG.md', 'sess-a', now);

    // Session B appends to it via Bash (`echo >> SESSION_LOG.md`).
    const before = await snapshotDirty(root, manifest);
    await writeFile(join(app, 'SESSION_LOG.md'), 'sess-b was here\n', 'utf8');
    const after = await snapshotDirty(root, manifest);

    const result = await claimBashChanges(root, 'sess-b', before, after, now);
    expect(result.touched).toEqual(['app/SESSION_LOG.md']);
    expect(result.collided).toBe(false);
    expect(result.lines).toEqual([]);

    // Session A's claim is untouched, and B never took or fought for its own claim.
    const claims = await listClaims(root, now);
    expect(claims).toHaveLength(1);
    expect(claims[0].session_id).toBe('sess-a');

    const notes = await readNotes(root, 'app/SESSION_LOG.md');
    expect(notes.some((n) => n.kind === 'claim' && n.session_id === 'sess-b' && n.msg.includes('append-only'))).toBe(true);
    expect(notes.some((n) => n.kind === 'deny')).toBe(false);
  });

  it('catches a revert (git checkout -- file) that flips a dirty file back to clean', async () => {
    const { root, app } = await freshWs();
    const manifest = parseManifest(MANIFEST);
    const now = Date.now();

    await writeFile(join(app, 'tracked.txt'), 'session A in-progress edit\n', 'utf8');
    const before = await snapshotDirty(root, manifest);
    expect(before).toHaveLength(1);

    // Session B runs `git checkout -- tracked.txt`, wiping A's uncommitted work.
    await execa('git', ['checkout', '--', 'tracked.txt'], { cwd: app });
    const after = await snapshotDirty(root, manifest);
    expect(after).toEqual([]);

    const result = await claimBashChanges(root, 'sess-b', before as DirtyEntry[], after, now);
    expect(result.touched).toEqual(['app/tracked.txt']);
  });
});
