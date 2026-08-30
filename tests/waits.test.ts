import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimFile, checkFile, releaseFiles, type RenameFn } from '../src/coord/claims';
import { waitForClaim } from '../src/coord/waits';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-waits-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('coord waits (auto-resume)', () => {
  it('acquires the file as soon as the holder releases', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'x.ts', 'A', now); // A holds it
    // release after a short delay, simulating A committing
    setTimeout(() => void releaseFiles(root, ['x.ts']), 80);
    const res = await waitForClaim(root, 'x.ts', 'B', { pollMs: 20, timeoutMs: 5000 });
    expect(res).toMatchObject({ acquired: true, reason: 'acquired' });
    expect(res.waited_ms).toBeGreaterThanOrEqual(0);
  });

  it('times out if the holder never releases', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'x.ts', 'A', now);
    const res = await waitForClaim(root, 'x.ts', 'B', { pollMs: 20, timeoutMs: 120 });
    expect(res).toMatchObject({ acquired: false, reason: 'timeout', held_by: 'A' });
  });

  it('breaks a deadlock by electing one survivor (A↔B each hold what the other waits for)', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'X.ts', 'A', now); // A holds X
    await claimFile(root, 'Y.ts', 'B', now); // B holds Y
    // B waits for X (held by A); A waits for Y (held by B) → cycle. One member is
    // elected to keep waiting (times out here, since neither releases); the other yields.
    const [bRes, aRes] = await Promise.all([
      waitForClaim(root, 'X.ts', 'B', { pollMs: 15, timeoutMs: 600 }),
      waitForClaim(root, 'Y.ts', 'A', { pollMs: 15, timeoutMs: 600 }),
    ]);
    expect([aRes, bRes].filter((r) => r.reason === 'deadlock').length).toBe(1); // exactly one yields
    expect(bRes.acquired).toBe(false);
    expect(aRes.acquired).toBe(false);
  });

  it('returns immediately when the file is already free', async () => {
    const root = await freshRoot();
    const res = await waitForClaim(root, 'free.ts', 'B', { pollMs: 20, timeoutMs: 1000 });
    expect(res).toMatchObject({ acquired: true, reason: 'acquired' });
  });
});

// Regression for the GHOST / STALE CLAIM observed live 2026-07-02 (handoff §4e/§6): a
// holder that acquired via `claim wait` committed and its post-commit release logged
// "Released 1 claim(s)", yet the next session was still denied by the released holder for
// minutes. Root cause: releaseWhere swallowed the unlink error and counted the claim as
// released even when the file could not actually be removed (a Windows EPERM/EBUSY from a
// concurrent poll holding the handle), so the claim record ghosted on disk.
describe('coord waits — commit after a wait-acquire fully releases (ghost-claim §6)', () => {
  const FILE = 'app/src/auth/session.ts';

  it('a wait-acquired claim is actually gone after release, and reclaims clean', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, FILE, 'S1', now); // S1 holds it (took it by editing first)
    setTimeout(() => void releaseFiles(root, [FILE]), 40); // S1 commits → releases
    // S3 acquires by waiting, exactly like `claim wait` (not a direct first edit).
    const res = await waitForClaim(root, FILE, 'S3', { pollMs: 15, timeoutMs: 5000 });
    expect(res.acquired).toBe(true);
    // S3 commits → the post-commit release frees any session's claim on the file.
    const n = await releaseFiles(root, [FILE]);
    expect(n).toBe(1);
    // The claim record is genuinely gone: a fresh session claims clean, not a ghost deny.
    const chk = await checkFile(root, FILE, 'S2', now + 1);
    expect(chk).toMatchObject({ ok: true, status: 'new' });
    const fresh = await claimFile(root, FILE, 'S2', now + 1);
    expect(fresh).toMatchObject({ ok: true, status: 'new' });
  });

  it('does NOT report releasing a claim whose file could not be unlinked', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'x.ts', 'S3', now); // S3 holds it
    // Model the Windows condition that produced the ghost: another process holds the claim
    // file's handle without FILE_SHARE_DELETE (PowerShell Get-Content, AV), so the removal
    // primitive — now the rename-to-tombstone (§7) — keeps failing EPERM.
    const lockedRename: RenameFn = async () => {
      const e = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
      e.code = 'EPERM';
      throw e;
    };
    const n = await releaseFiles(root, ['x.ts'], undefined, lockedRename);
    expect(n).toBe(0); // must NOT claim a release it could not perform — the old bug counted 1 here
    // The claim genuinely survives, so the next session is (correctly) still denied —
    // NOT ghosted by a false "released" that leaves the record on disk.
    const chk = await checkFile(root, 'x.ts', 'S2', now);
    expect(chk.ok).toBe(false);
    if (!chk.ok) expect(chk.held_by).toBe('S3');
  });

  it('retries a transient unlink lock so the release truly lands (no ghost left behind)', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'x.ts', 'S3', now);
    let calls = 0;
    const flaky: RenameFn = async (from, to) => {
      if (calls++ === 0) {
        const e = new Error('EBUSY: resource busy or locked, rename') as NodeJS.ErrnoException;
        e.code = 'EBUSY';
        throw e; // first attempt loses the race with a concurrent handle...
      }
      return rename(from, to); // ...the lock clears, the retry succeeds
    };
    const n = await releaseFiles(root, ['x.ts'], undefined, flaky);
    expect(n).toBe(1); // recovered on retry → a real, honestly-counted release
    const fresh = await claimFile(root, 'x.ts', 'Z', now + 1);
    expect(fresh).toMatchObject({ ok: true, status: 'new' }); // gone for real
  });

  it('restores — not destroys — a claim that changed between the read and the removal (§7 TOCTOU)', async () => {
    const root = await freshRoot();
    const now = Date.now();
    await claimFile(root, 'x.ts', 'S3', now); // S3 holds it; a release scoped to S3 begins
    // Between releaseWhere's read (which saw S3) and its rename, another session's
    // takeover lands on the same slot. The old read-then-unlink destroyed S9's live
    // claim here; the tombstone re-judge must restore it and report nothing released.
    const raceRename: RenameFn = async (from, to) => {
      await writeFile(from, JSON.stringify({ file: 'x.ts', session_id: 'S9', claimed_at: new Date(now).toISOString(), ttl_sec: 1800 }, null, 2) + '\n', 'utf8');
      return rename(from, to);
    };
    const n = await releaseFiles(root, ['x.ts'], 'S3', raceRename);
    expect(n).toBe(0); // S9's record no longer matches the S3-scoped predicate
    const chk = await checkFile(root, 'x.ts', 'S2', now);
    expect(chk.ok).toBe(false); // S9's claim survived the sweep intact
    if (!chk.ok) expect(chk.held_by).toBe('S9');
  });
});
