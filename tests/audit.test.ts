import { describe, it, expect, afterEach } from 'bun:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendAuditEntry, readAuditLog, verifyAuditLog } from '../src/audit';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('audit log', () => {
  it('chains entries and verifies clean', async () => {
    dir = await mkdtemp(join(tmpdir(), 'repolith-audit-'));
    const logPath = join(dir, 'audit.jsonl');
    await appendAuditEntry(logPath, { ts: '2026-01-01T00:00:00.000Z', agentId: 'alice', tool: 'repolith_state', ok: true });
    await appendAuditEntry(logPath, { ts: '2026-01-01T00:00:01.000Z', agentId: 'alice', tool: 'repolith_checkout', ok: true });

    const entries = await readAuditLog(logPath);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.prevHash).toBe('0'.repeat(64));
    expect(entries[1]!.prevHash).toBe(entries[0]!.hash);

    const v = await verifyAuditLog(logPath);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(2);
    expect(v.brokenAtLine).toBeNull();
  });

  it('records failures too, with the error message', async () => {
    dir = await mkdtemp(join(tmpdir(), 'repolith-audit-'));
    const logPath = join(dir, 'audit.jsonl');
    await appendAuditEntry(logPath, {
      ts: '2026-01-01T00:00:00.000Z',
      agentId: 'bob',
      tool: 'repolith_checkout',
      ok: false,
      error: 'no checkout grant',
    });
    const [entry] = await readAuditLog(logPath);
    expect(entry!.ok).toBe(false);
    expect(entry!.error).toBe('no checkout grant');
  });

  it('detects tampering with an entry after the fact', async () => {
    dir = await mkdtemp(join(tmpdir(), 'repolith-audit-'));
    const logPath = join(dir, 'audit.jsonl');
    await appendAuditEntry(logPath, { ts: '2026-01-01T00:00:00.000Z', agentId: 'alice', tool: 'repolith_state', ok: true });
    await appendAuditEntry(logPath, { ts: '2026-01-01T00:00:01.000Z', agentId: 'alice', tool: 'repolith_checkout', ok: true });

    const lines = (await readFile(logPath, 'utf8')).trim().split('\n');
    const tampered = JSON.parse(lines[0]!);
    tampered.agentId = 'mallory'; // rewrite history: pretend alice's read was mallory's
    lines[0] = JSON.stringify(tampered);
    await writeFile(logPath, lines.join('\n') + '\n', 'utf8');

    const v = await verifyAuditLog(logPath);
    expect(v.ok).toBe(false);
    expect(v.brokenAtLine).toBe(1);
  });

  it('treats a missing log file as empty and verified', async () => {
    dir = await mkdtemp(join(tmpdir(), 'repolith-audit-'));
    const logPath = join(dir, 'missing.jsonl');
    expect(await readAuditLog(logPath)).toEqual([]);
    const v = await verifyAuditLog(logPath);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(0);
  });

  it('serializes concurrent appends into one unbroken chain', async () => {
    dir = await mkdtemp(join(tmpdir(), 'repolith-audit-'));
    const logPath = join(dir, 'audit.jsonl');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        appendAuditEntry(logPath, { ts: new Date(2026, 0, 1, 0, 0, i).toISOString(), agentId: 'alice', tool: `t${i}`, ok: true }),
      ),
    );
    const v = await verifyAuditLog(logPath);
    expect(v.ok).toBe(true);
    expect(v.entries).toBe(10);
  });
});
