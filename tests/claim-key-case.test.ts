import { describe, it, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { claimFile, DEFAULT_CLAIM_TTL } from '../src/coord/claims';
import { fileKey } from '../src/coord/fileKey';

const caseInsensitiveFs = process.platform === 'win32' || process.platform === 'darwin';

async function ws(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'repolith-key-'));
}

describe('claim key canonicalization', () => {
  it('folds case only on case-insensitive filesystems', () => {
    expect(fileKey('src/Types.ts')).toBe(caseInsensitiveFs ? 'src/types.ts' : 'src/Types.ts');
    expect(fileKey('src/types.ts')).toBe('src/types.ts');
  });

  // The reported failure: the Edit gate keys off the tool payload's casing while the
  // Bash backstop keys off the casing git recorded. On one NTFS file that produced two
  // claim records, so both sessions believed they held it exclusively.
  it.if(caseInsensitiveFs)('treats two casings of one file as the same claim', async () => {
    const root = await ws();
    try {
      const a = await claimFile(root, 'src/Types.ts', 'sess-edit', Date.now(), DEFAULT_CLAIM_TTL);
      expect(a.ok).toBe(true);

      // A different session arriving via the Bash backstop with git's casing must collide.
      const b = await claimFile(root, 'src/types.ts', 'sess-bash', Date.now(), DEFAULT_CLAIM_TTL);
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.held_by).toBe('sess-edit');

      // ...and exactly one record exists on disk, not two.
      expect((await readdir(join(root, '.repolith', 'claims'))).length).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('still distinguishes genuinely different files', async () => {
    const root = await ws();
    try {
      expect((await claimFile(root, 'src/a.ts', 's1', Date.now(), DEFAULT_CLAIM_TTL)).ok).toBe(true);
      expect((await claimFile(root, 'src/b.ts', 's2', Date.now(), DEFAULT_CLAIM_TTL)).ok).toBe(true);
      expect((await readdir(join(root, '.repolith', 'claims'))).length).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('claim takeover atomicity', () => {
  // A dead holder: TTL long expired and no heartbeat file, so isSessionAlive() is false.
  async function plantDeadClaim(root: string, file: string, holder: string): Promise<void> {
    const dir = join(root, '.repolith', 'claims');
    await mkdir(dir, { recursive: true });
    const name = createHash('sha256').update(fileKey(file)).digest('hex').slice(0, 16) + '.json';
    const claimedAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(); // 10 h ago
    await writeFile(join(dir, name), JSON.stringify({ file, session_id: holder, claimed_at: claimedAt, ttl_sec: 60 }), 'utf8');
  }

  it('lets exactly one of two racing sessions take over a dead claim', async () => {
    const root = await ws();
    try {
      await plantDeadClaim(root, 'src/auth.ts', 'sess-crashed');

      // Both evaluate the dead holder in the same window. Before the fix both wrote the
      // claim and both got `took-over`, so both edited believing they held it.
      const [a, b] = await Promise.all([
        claimFile(root, 'src/auth.ts', 'sess-a', Date.now(), DEFAULT_CLAIM_TTL),
        claimFile(root, 'src/auth.ts', 'sess-b', Date.now(), DEFAULT_CLAIM_TTL),
      ]);

      const winners = [a, b].filter((r) => r.ok);
      expect(winners.length).toBe(1);
      const loser = [a, b].find((r) => !r.ok);
      expect(loser).toBeDefined();
      // The loser must be told who actually holds it — never the crashed session.
      if (loser && !loser.ok) expect(['sess-a', 'sess-b']).toContain(loser.held_by);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('a single session still takes over a dead claim cleanly', async () => {
    const root = await ws();
    try {
      await plantDeadClaim(root, 'src/auth.ts', 'sess-crashed');
      const r = await claimFile(root, 'src/auth.ts', 'sess-new', Date.now(), DEFAULT_CLAIM_TTL);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.status).toBe('took-over');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
