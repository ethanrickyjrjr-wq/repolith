// Integration test for the `plan-hook` stdout CONTRACT — the behavioral surface
// Phase 3 changed. `renderSemanticCheck` is unit-tested in isolation; this pins
// the wiring in plan.ts (the early-return that Phase 3 fixed) at the real entry
// point: a crafted Claude Code hook payload on stdin → hookSpecificOutput on stdout.
//
// NB the contract shifted at Phase 3: "path-clear ⇒ prints nothing" is no longer
// true — a path-clear plan with a substantive active peer must still emit the
// semantic cross-check (advisory, no permissionDecision). That's exactly the
// regression this guards.

import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { readNotes, SEMANTIC_LOG_KEY } from '../src/coord/journal';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const MANIFEST = `[workspace]
name = "hookws"

[[repos]]
name = "app"
url = "https://example.com/app.git"
path = "app"
ref = "main"
`;

const roots: string[] = [];
async function freshWs(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'repolith-planhook-'));
  roots.push(root);
  await writeFile(join(root, 'repolith.toml'), MANIFEST, 'utf8');
  await mkdir(join(root, '.repolith', 'sessions'), { recursive: true });
  return root;
}
async function writePeer(root: string, id: string, summary: string, areas: string[], excerpt: string): Promise<void> {
  const now = new Date().toISOString();
  await writeFile(
    join(root, '.repolith', 'sessions', `${id}.json`),
    JSON.stringify({
      session_id: id,
      workspace: 'hookws',
      summary,
      areas,
      status: 'planning',
      plan_excerpt: excerpt,
      started_at: now,
      updated_at: now,
      ttl_sec: 3600,
    }),
    'utf8',
  );
}
/** Drive the real CLI hook: payload on stdin → parsed hookSpecificOutput (or null on empty stdout). */
async function runHook(root: string, sessionId: string, plan: string): Promise<{ stdout: string; parsed: any }> {
  const payload = JSON.stringify({ session_id: sessionId, cwd: root, tool_input: { plan } });
  // Never let the hook fire a real dashboard upload from a test (it would spawn the
  // PowerShell uploader and block up to 8s per call — see snapshotPush.ts).
  const { stdout } = await execa('bun', [CLI, 'plan-hook'], {
    input: payload,
    env: { ...process.env, REPOLITH_NO_SNAPSHOT_PUSH: '1' },
  });
  return { stdout, parsed: stdout.trim() ? JSON.parse(stdout) : null };
}

afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('plan-hook stdout contract', () => {
  it('path-DISJOINT plan with an active peer → emits the semantic block, NO permissionDecision (Phase 3 fix)', async () => {
    const root = await freshWs();
    // Peer lives in a completely different tree → path-overlap is clear.
    await writePeer(root, 'B', 'gate invoices on the auth check', ['lib/billing/invoice.ts'], 'Call authenticate() to gate the invoice route.');
    const { parsed } = await runHook(root, 'A', 'Rename `authenticate()` to `verifySession()` in `core/security/session.ts`.');

    expect(parsed).not.toBeNull();
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('semantic cross-check');
    expect(ctx).toContain('gate invoices on the auth check'); // the peer's intent, surfaced
    expect(ctx).not.toContain('plan-coordination'); // path layer stayed silent — this fired on its own
    expect(parsed.hookSpecificOutput.permissionDecision).toBeUndefined(); // advisory, never blocks

    // Observability: the surfacing is journaled (aggregate log) so the live
    // false-positive rate is measurable.
    const notes = await readNotes(root, SEMANTIC_LOG_KEY);
    expect(notes.some((n) => n.kind === 'semantic' && n.session_id === 'A' && n.msg.includes('B'))).toBe(true);
  });

  it('journals the surfacing even when BOTH plans declare only globs/dirs (no concrete file to key on)', async () => {
    const root = await freshWs();
    // Peer declares a bare directory; A's plan mentions only a glob → neither has a concrete file.
    await writePeer(root, 'B', 'rework the api layer', ['src/api/'], 'Restructure the api handlers.');
    const { parsed } = await runHook(root, 'A', 'Refactor everything under `src/ui/**` — broad sweep.');

    expect(parsed).not.toBeNull();
    expect((parsed.hookSpecificOutput.additionalContext as string)).toContain('semantic cross-check');
    // The gap this closes: previously no concrete file ⇒ no note ⇒ unmeasurable. Now aggregated.
    const notes = await readNotes(root, SEMANTIC_LOG_KEY);
    expect(notes.some((n) => n.kind === 'semantic' && n.session_id === 'A' && n.msg.includes('B'))).toBe(true);
  });

  it('truly alone (no other session) → prints nothing, exit 0', async () => {
    const root = await freshWs();
    const { stdout, parsed } = await runHook(root, 'A', 'Refactor `src/solo.ts` — nobody else is here.');
    expect(stdout.trim()).toBe('');
    expect(parsed).toBeNull();
  });

  it('HARD path overlap (same file) → still escalates to permissionDecision:"ask"', async () => {
    const root = await freshWs();
    await writePeer(root, 'B', 'owns the app entrypoint', ['src/app.ts'], 'Rework src/app.ts startup.');
    const { parsed } = await runHook(root, 'A', 'Also edit `src/app.ts` — change the boot sequence.');

    expect(parsed).not.toBeNull();
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('ask');
    const ctx = parsed.hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain('plan-coordination'); // the hard path catch
    expect(ctx).toContain('semantic cross-check'); // and the semantic block rides along
  });
});
