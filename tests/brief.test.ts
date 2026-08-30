import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePlan, type SessionPlan } from '../src/coord/store';
import { appendNote } from '../src/coord/journal';
import { buildBrief } from '../src/coord/brief';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-brief-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const NOW = Date.parse('2026-06-28T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
function seedPlan(root: string, id: string, areas: string[], summary = 'do the thing'): Promise<void> {
  const p: SessionPlan = {
    session_id: id,
    workspace: 'ws',
    summary,
    areas,
    status: 'planning',
    started_at: iso(NOW),
    updated_at: iso(NOW),
    ttl_sec: 3600,
  };
  return writePlan(root, p);
}

describe('buildBrief', () => {
  it('surfaces unseen notes from others, excludes the session’s own', async () => {
    const root = await freshRoot();
    await appendNote(root, { file: 'app/src/foo.ts', kind: 'commit', msg: 'B changed foo', sha: 'abc1234567', ts: iso(NOW - 60_000) });
    await appendNote(root, { file: 'app/src/foo.ts', kind: 'claim', msg: 'my own note', session_id: 'me', ts: iso(NOW - 30_000) });
    const brief = await buildBrief(root, 'me', 'app/src/foo.ts', NOW);
    expect(brief).toContain('B changed foo');
    expect(brief).not.toContain('my own note');
  });

  it('excludes deny/wait/overlap notes — observability, not work to inherit', async () => {
    const root = await freshRoot();
    await appendNote(root, { file: 'app/src/foo.ts', kind: 'deny', msg: 'edit blocked — held by A', session_id: 'B', ts: iso(NOW - 60_000) });
    await appendNote(root, { file: 'app/src/foo.ts', kind: 'wait', msg: 'resumed after 5s — was held by A', session_id: 'B', ts: iso(NOW - 50_000) });
    await appendNote(root, { file: 'app/src/foo.ts', kind: 'overlap', msg: 'plan overlap (hard) with A — escalated to review', session_id: 'B', ts: iso(NOW - 40_000) });
    expect(await buildBrief(root, 'me', 'app/src/foo.ts', NOW)).toBeNull();
  });

  it('does not re-show notes already seen', async () => {
    const root = await freshRoot();
    await appendNote(root, { file: 'app/src/foo.ts', kind: 'commit', msg: 'one', ts: iso(NOW - 60_000) });
    expect(await buildBrief(root, 'me', 'app/src/foo.ts', NOW)).toContain('one');
    expect(await buildBrief(root, 'me', 'app/src/foo.ts', NOW + 1000)).toBeNull(); // nothing new, no plan
  });

  it('restates the task once for in-scope edits, then stays silent (no nag)', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/**'], 'wire foo');
    const first = await buildBrief(root, 'me', 'app/src/foo.ts', NOW);
    expect(first).toContain('wire foo');
    const second = await buildBrief(root, 'me', 'app/src/bar.ts', NOW); // also in scope, already anchored
    expect(second).toBeNull();
  });

  it('flags scope-creep when the file is outside declared areas', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/auth.ts'], 'do auth');
    const brief = await buildBrief(root, 'me', 'app/src/billing.ts', NOW);
    expect(brief).toContain('scope creep');
    expect(brief).toContain('do auth');
  });

  it('treats a repo-relative declared file as in-scope for the workspace-relative claim', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/auth.ts'], 'do auth');
    const brief = await buildBrief(root, 'me', 'app/src/auth.ts', NOW); // suffix match → in scope
    expect(brief).not.toContain('scope creep');
    expect(brief).toContain('do auth'); // anchored once
  });

  it('nothing to say (no plan, no notes) → null', async () => {
    const root = await freshRoot();
    expect(await buildBrief(root, 'me', 'app/src/foo.ts', NOW)).toBeNull();
  });

  it('drops notes older than the 48 h recency window', async () => {
    const root = await freshRoot();
    const stale = NOW - 49 * 60 * 60 * 1000; // 49 h ago — outside the 48 h window
    await appendNote(root, { file: 'app/src/foo.ts', kind: 'commit', msg: 'very old commit', sha: 'aaa', ts: iso(stale) });
    await appendNote(root, { file: 'app/src/foo.ts', kind: 'commit', msg: 'recent commit', sha: 'bbb', ts: iso(NOW - 60_000) });
    const brief = await buildBrief(root, 'me', 'app/src/foo.ts', NOW);
    expect(brief).not.toContain('very old commit');
    expect(brief).toContain('recent commit');
  });

  it('scope-creep flag is advisory (nudges to consult an advisor, does not block)', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/auth.ts'], 'do auth');
    const brief = await buildBrief(root, 'me', 'app/src/billing.ts', NOW);
    expect(brief).toContain('scope creep');
    expect(brief).toContain('Advisory');
    expect(brief).toContain('advisor');
  });
});

describe('inDeclaredScope membership — scope-creep false-negative fixes', () => {
  it('a root-level file does NOT ride into a plan scoped to a subdir', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/auth.ts'], 'do auth');
    // was a silent false-negative: README.md's empty dir is a prefix of every area
    const brief = await buildBrief(root, 'me', 'README.md', NOW);
    expect(brief).toContain('scope creep');
  });

  it('a same-dir sibling of a declared FILE is flagged, not assumed in-scope', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/auth/login.ts'], 'do login');
    // the "right" side of the tradeoff: an unrelated sibling no longer rides in
    const brief = await buildBrief(root, 'me', 'src/auth/oauth.ts', NOW);
    expect(brief).toContain('scope creep');
  });

  it('a prose-described-but-unnamed sibling is ALSO flagged now — deliberate advisory tradeoff', async () => {
    // The "wrong" side of the same tradeoff: token.ts is genuinely in-scope ("add a token
    // helper alongside them") but isn't path-named, so tightening membership flags it as a
    // possible-scope-creep false-positive. Acceptable ONLY because the flag is ADVISORY, not a
    // block — the cost is one "confirm it's on-task" nudge; the win is that unrelated siblings
    // (oauth.ts) and root files stop riding in silently. We trade sibling false-NEGATIVES for
    // sibling false-POSITIVES; net-good because flagging is advisory, not blocking.
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/auth/login.ts', 'src/auth/session.ts'], 'jwt migration');
    const brief = await buildBrief(root, 'me', 'src/auth/token.ts', NOW);
    expect(brief).toContain('scope creep'); // flagged (was clean pre-fix) — by design
  });

  it('a declared DIRECTORY area still covers its descendants (no over-tightening)', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/auth'], 'work the auth dir'); // dir-like concrete area
    const brief = await buildBrief(root, 'me', 'src/auth/login.ts', NOW);
    expect(brief).not.toContain('scope creep');
    expect(brief).toContain('work the auth dir'); // in scope → anchored once
  });

  it('the declared file itself stays in-scope (exact + repo-relative suffix)', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/auth/login.ts'], 'do login');
    expect(await buildBrief(root, 'me', 'src/auth/login.ts', NOW)).not.toContain('scope creep');
    const root2 = await freshRoot();
    await seedPlan(root2, 'me', ['src/auth/login.ts'], 'do login');
    expect(await buildBrief(root2, 'me', 'app/src/auth/login.ts', NOW)).not.toContain('scope creep');
  });

  it('a glob area still covers its subtree', async () => {
    const root = await freshRoot();
    await seedPlan(root, 'me', ['src/**'], 'all of src');
    expect(await buildBrief(root, 'me', 'app/src/deep/x.ts', NOW)).not.toContain('scope creep');
  });
});
