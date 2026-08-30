import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimFile, checkFile, claimHolder, releaseFiles, type RenameFn } from '../src/coord/claims';
import { writeRevocation, readRevocation, REVOCATION_TTL_SEC, OVERRIDE_HOLDER } from '../src/coord/revocation';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-revoke-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const FILE = 'repos/app/lib/social/CLAUDE.md';

/** The operator override as `claim release --file` performs it: learn the holder, release, bar it. */
async function override(root: string, file: string, nowMs: number): Promise<string | null> {
  const booted = await claimHolder(root, file);
  const n = await releaseFiles(root, [file]);
  if (booted && n > 0) await writeRevocation(root, file, booted, nowMs);
  return booted;
}

describe('operator-override revocation', () => {
  it('closes the boomerang: the booted session cannot silently re-take the file', async () => {
    const root = await freshRoot();
    const now = Date.now();

    expect((await claimFile(root, FILE, 'A', now)).status).toBe('new');
    expect(await override(root, FILE, now)).toBe('A');

    // The whole bug: before this fix A won the free `wx` slot and the override reversed itself.
    const retake = await claimFile(root, FILE, 'A', now + 1000);
    expect(retake.ok).toBe(false);
    if (!retake.ok) {
      expect(retake.revoked).toBeTruthy();
      expect(retake.held_by).toBe(OVERRIDE_HOLDER);
    }
  });

  it('leaves the file free for the session the override was FOR', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);
    await override(root, FILE, now);

    // B is who the operator was unblocking — the bar names A only.
    expect((await claimFile(root, FILE, 'B', now + 1000)).status).toBe('new');
  });

  it('bars only the booted session, never a bystander', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);
    await override(root, FILE, now);

    expect((await claimFile(root, FILE, 'C', now + 500)).status).toBe('new');
  });

  it('clears the bar once another session takes the file, so a later collision is honest', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);
    await override(root, FILE, now);
    await claimFile(root, FILE, 'B', now + 1000); // override served its purpose
    expect(await readRevocation(root, FILE, now + 1000)).toBeNull();

    // B releases on commit; A may now legitimately take the file back — it is no longer barred.
    await releaseFiles(root, [FILE]);
    expect((await claimFile(root, FILE, 'A', now + 2000)).status).toBe('new');
  });

  it('lapses after the TTL so an abandoned override never strands the file', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);
    await override(root, FILE, now);

    const past = now + REVOCATION_TTL_SEC * 1000 + 1;
    expect(await readRevocation(root, FILE, past)).toBeNull();
    expect((await claimFile(root, FILE, 'A', past)).status).toBe('new');
  });

  it('checkFile mirrors the bar — a waiter is never told a file it cannot claim is free', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);
    await override(root, FILE, now);

    // waits.ts polls checkFile; if it disagreed with claimFile the waiter would "acquire"
    // a file its own claim attempt refuses, and spin.
    const obs = await checkFile(root, FILE, 'A', now + 1000);
    expect(obs.ok).toBe(false);
    if (!obs.ok) expect(obs.revoked).toBeTruthy();
    expect((await checkFile(root, FILE, 'B', now + 1000)).ok).toBe(true);
  });

  it('a PLAIN release bars nobody — normal FIFO handoff must keep working', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);

    // This is the commit-release / waiter path (releaseFiles direct, no override).
    await releaseFiles(root, [FILE]);
    expect(await readRevocation(root, FILE, now)).toBeNull();
    expect((await claimFile(root, FILE, 'A', now + 100)).status).toBe('new');
  });

  it('releasing an unheld file is a no-op, not an override — it bars nobody', async () => {
    const root = await freshRoot();
    const now = Date.now();
    expect(await override(root, FILE, now)).toBeNull();
    expect(await readRevocation(root, FILE, now)).toBeNull();
    expect((await claimFile(root, FILE, 'A', now)).status).toBe('new');
  });

  it('a release that could not actually free the claim bars nobody', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);

    // The Windows locked-handle path (claims.ts): an AV scanner or coord-push.ps1 holds the
    // record, rename keeps failing, releaseFiles honestly reports 0. Nothing was overridden,
    // so nothing may be barred — otherwise the operator bars a session off a file that is
    // still held by that same session, and sees "Released 0 claim(s)" while it happens.
    const lockedRename: RenameFn = async () => {
      const e = new Error('EPERM') as NodeJS.ErrnoException;
      e.code = 'EPERM';
      throw e;
    };
    const booted = await claimHolder(root, FILE);
    const n = await releaseFiles(root, [FILE], undefined, lockedRename);
    expect(booted).toBe('A');
    expect(n).toBe(0); // nothing freed
    if (booted && n > 0) await writeRevocation(root, FILE, booted, now); // guard must not fire

    expect(await readRevocation(root, FILE, now)).toBeNull();
    // A still holds it — the claim was never freed, so A renews rather than being barred.
    expect((await claimFile(root, FILE, 'A', now + 100)).status).toBe('renewed');
  });

  it('concurrent sweeps of one lapsed record do not throw', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);
    await override(root, FILE, now);

    // checkFile is polled in a loop by every waiter (waits.ts), and a lapsed `.revoked` is
    // swept on read — so several waiters can race to unlink the same record. The loser hits
    // ENOENT, which must stay benign rather than surfacing as a claim failure.
    const past = now + REVOCATION_TTL_SEC * 1000 + 1;
    const settled = await Promise.all([
      readRevocation(root, FILE, past),
      readRevocation(root, FILE, past),
      checkFile(root, FILE, 'A', past),
      checkFile(root, FILE, 'B', past),
    ]);
    expect(settled[0]).toBeNull();
    expect(settled[1]).toBeNull();
    expect(settled[2].ok).toBe(true); // bar lapsed — A is free again
    expect(settled[3].ok).toBe(true);
  });

  it('a corrupt revocation record never bars an edit', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'A', now);
    await override(root, FILE, now);

    // Simulate a torn/partial write: unreadable records must fail OPEN, like every other
    // advisory record in this store.
    const { writeFile } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const { fileKey } = await import('../src/coord/fileKey');
    const p = join(root, '.repolith', 'claims', createHash('sha256').update(fileKey(FILE)).digest('hex').slice(0, 16) + '.revoked');
    await writeFile(p, '{ not json');

    expect(await readRevocation(root, FILE, now)).toBeNull();
    expect((await claimFile(root, FILE, 'A', now + 100)).status).toBe('new');
  });
});
