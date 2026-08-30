import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SPEC_PATTERNS,
  matchesSpecPattern,
  relativizeSpecPath,
  registerSpec,
  planDeclare,
} from '../src/commands/spec';
import { mergePlan, readPlan, type SessionPlan } from '../src/coord/store';
import { parseManifest } from '../src/manifest';
import { readNotes } from '../src/coord/journal';

process.env.REPOLITH_NO_SNAPSHOT_PUSH = '1'; // never fire a live Blob upload from tests

const MANIFEST = `[workspace]
name = "demo"

[[repos]]
name = "app"
url = "https://example.com/app.git"
path = "app"
ref = "main"
`;

const roots: string[] = [];
async function freshWs(manifestToml: string = MANIFEST): Promise<{ root: string; manifest: ReturnType<typeof parseManifest> }> {
  const root = await mkdtemp(join(tmpdir(), 'repolith-spec-'));
  roots.push(root);
  await writeFile(join(root, 'repolith.toml'), manifestToml, 'utf8');
  return { root, manifest: parseManifest(manifestToml) };
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

describe('matchesSpecPattern()', () => {
  it('matches the default patterns at any depth, including zero directories', () => {
    expect(matchesSpecPattern('docs/superpowers/specs/feature.md', DEFAULT_SPEC_PATTERNS)).toBe(true);
    expect(matchesSpecPattern('specs/feature.md', DEFAULT_SPEC_PATTERNS)).toBe(true);
    expect(matchesSpecPattern('plans/rollout.md', DEFAULT_SPEC_PATTERNS)).toBe(true);
    expect(matchesSpecPattern('app/plans/sub/rollout.md', DEFAULT_SPEC_PATTERNS)).toBe(true);
    expect(matchesSpecPattern('feature.plan.md', DEFAULT_SPEC_PATTERNS)).toBe(true);
    expect(matchesSpecPattern('app/docs/feature.plan.md', DEFAULT_SPEC_PATTERNS)).toBe(true);
  });

  it('does not match ordinary files', () => {
    expect(matchesSpecPattern('src/index.ts', DEFAULT_SPEC_PATTERNS)).toBe(false);
    expect(matchesSpecPattern('README.md', DEFAULT_SPEC_PATTERNS)).toBe(false);
    expect(matchesSpecPattern('docs/notes.md', DEFAULT_SPEC_PATTERNS)).toBe(false);
    expect(matchesSpecPattern('plansX/foo.md', DEFAULT_SPEC_PATTERNS)).toBe(false); // 'plans' must be a whole segment
  });

  it('always excludes coordination-internal and VCS paths, even if a pattern matches', () => {
    expect(matchesSpecPattern('.repolith/specs/x.md', DEFAULT_SPEC_PATTERNS)).toBe(false);
    expect(matchesSpecPattern('.claude/plans/x.md', DEFAULT_SPEC_PATTERNS)).toBe(false);
    expect(matchesSpecPattern('app/.git/specs/x.md', DEFAULT_SPEC_PATTERNS)).toBe(false);
  });

  it('honors custom patterns', () => {
    expect(matchesSpecPattern('rfcs/001.md', ['rfcs/*.md'])).toBe(true);
    expect(matchesSpecPattern('specs/feature.md', ['rfcs/*.md'])).toBe(false);
  });
});

describe('relativizeSpecPath()', () => {
  it('relativizes against the root and normalizes to forward slashes', () => {
    const root = join(tmpdir(), 'ws-root');
    // join() produces native separators — on Windows this exercises the backslash normalization
    expect(relativizeSpecPath(root, join(root, 'plans', 'x.md'))).toBe('plans/x.md');
  });
  it('rejects paths escaping the workspace root', () => {
    const root = join(tmpdir(), 'ws-root');
    expect(relativizeSpecPath(root, join(tmpdir(), 'other', 'plans', 'x.md'))).toBeNull();
  });
});

describe('mergePlan()', () => {
  const base = (over: Partial<SessionPlan>): SessionPlan => ({
    session_id: 's1',
    workspace: 'demo',
    summary: 'old summary',
    areas: ['a.ts', 'b.ts'],
    status: 'planning',
    started_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ttl_sec: 3600,
    ...over,
  });

  it('unions areas newest-first, preserves started_at, latest summary wins', () => {
    const merged = mergePlan(
      base({}),
      base({ areas: ['c.ts', 'a.ts'], summary: 'new summary', started_at: '2026-08-02T00:00:00.000Z', updated_at: '2026-08-02T00:00:00.000Z', source: 'spec' }),
    );
    expect(merged.areas).toEqual(['c.ts', 'a.ts', 'b.ts']);
    expect(merged.summary).toBe('new summary');
    expect(merged.started_at).toBe('2026-08-01T00:00:00.000Z'); // session age stays honest
    expect(merged.updated_at).toBe('2026-08-02T00:00:00.000Z');
    expect(merged.source).toBe('spec');
  });

  it('caps merged areas at 25, newest extraction winning the cap fight', () => {
    const oldAreas = Array.from({ length: 25 }, (_, i) => `old${i}.ts`);
    const newAreas = Array.from({ length: 20 }, (_, i) => `new${i}.ts`);
    const merged = mergePlan(base({ areas: oldAreas }), base({ areas: newAreas }));
    expect(merged.areas).toHaveLength(25);
    expect(merged.areas.slice(0, 20)).toEqual(newAreas);
  });

  it('unions spec_files and tolerates plans without the new optional fields', () => {
    const merged = mergePlan(base({ spec_files: ['plans/a.md'] }), base({ spec_files: ['plans/b.md'] }));
    expect(merged.spec_files!.sort()).toEqual(['plans/a.md', 'plans/b.md']);
    const compat = mergePlan(base({}), base({})); // neither side has source/spec_files
    expect(compat.spec_files).toBeUndefined();
  });

  it('no existing plan → incoming as-is', () => {
    const incoming = base({ source: 'declare' });
    expect(mergePlan(null, incoming)).toBe(incoming);
  });
});

describe('registerSpec()', () => {
  it('registers a spec file: areas extracted, self-path dropped, plan notes journaled', async () => {
    const { root, manifest } = await freshWs();
    await mkdir(join(root, 'plans'), { recursive: true });
    const spec = [
      '# Feature X rollout',
      '',
      'Touch `app/src/feature-x.ts` and `app/src/shared/api.ts`.',
      'This plan lives at plans/feature-x.md and supersedes nothing.',
    ].join('\n');
    await writeFile(join(root, 'plans', 'feature-x.md'), spec, 'utf8');

    const now = Date.now();
    const reg = await registerSpec(root, manifest, 'sess-a', join(root, 'plans', 'feature-x.md'), now);
    expect(reg).not.toBeNull();
    expect(reg!.rel).toBe('plans/feature-x.md');
    expect(reg!.report.clear).toBe(true);
    expect(reg!.context).toBeNull();

    const stored = await readPlan(root, 'sess-a', now);
    expect(stored).not.toBeNull();
    expect(stored!.source).toBe('spec');
    expect(stored!.spec_files).toEqual(['plans/feature-x.md']);
    expect(stored!.summary).toBe('Feature X rollout');
    expect(stored!.areas).toContain('app/src/feature-x.ts');
    expect(stored!.areas).toContain('app/src/shared/api.ts');
    expect(stored!.areas).not.toContain('plans/feature-x.md'); // self-reference dropped

    const notes = await readNotes(root, 'app/src/feature-x.ts');
    expect(notes.some((n) => n.kind === 'plan' && n.session_id === 'sess-a')).toBe(true);
  });

  it('returns null for a non-spec path or a path escaping the root', async () => {
    const { root, manifest } = await freshWs();
    await writeFile(join(root, 'notes.md'), 'not a spec, mentions src/x.ts', 'utf8');
    expect(await registerSpec(root, manifest, 'sess-a', join(root, 'notes.md'), Date.now())).toBeNull();
    expect(await registerSpec(root, manifest, 'sess-a', join(root, '..', 'outside', 'plans', 'x.md'), Date.now())).toBeNull();
  });

  it('flags overlap between two sessions\' specs and journals it', async () => {
    const { root, manifest } = await freshWs();
    await mkdir(join(root, 'plans'), { recursive: true });
    await writeFile(join(root, 'plans', 'a.md'), '# A\n\nEdit `app/src/shared/api.ts`.', 'utf8');
    await writeFile(join(root, 'plans', 'b.md'), '# B\n\nAlso edit `app/src/shared/api.ts`.', 'utf8');

    const now = Date.now();
    const first = await registerSpec(root, manifest, 'sess-a', join(root, 'plans', 'a.md'), now);
    expect(first!.report.clear).toBe(true);

    const second = await registerSpec(root, manifest, 'sess-b', join(root, 'plans', 'b.md'), now + 10);
    expect(second!.report.clear).toBe(false);
    expect(second!.report.conflicts[0].with_session).toBe('sess-a');
    expect(second!.context).toContain('plans/b.md');
    expect(second!.context).toContain('repolith plan-coordination');

    // sess-a's registration untouched by sess-b's
    const a = await readPlan(root, 'sess-a', now + 20);
    expect(a!.areas).toContain('app/src/shared/api.ts');

    const notes = await readNotes(root, 'app/src/shared/api.ts');
    expect(notes.some((n) => n.kind === 'overlap' && n.session_id === 'sess-b')).toBe(true);
  });

  it('a same-session re-save merges scope instead of clobbering (no self-conflict)', async () => {
    const { root, manifest } = await freshWs();
    await mkdir(join(root, 'plans'), { recursive: true });
    await writeFile(join(root, 'plans', 'a.md'), '# A\n\nEdit `app/src/one.ts`.', 'utf8');
    const now = Date.now();
    await registerSpec(root, manifest, 'sess-a', join(root, 'plans', 'a.md'), now);

    await writeFile(join(root, 'plans', 'a.md'), '# A v2\n\nEdit `app/src/two.ts`.', 'utf8');
    const reg = await registerSpec(root, manifest, 'sess-a', join(root, 'plans', 'a.md'), now + 10);
    expect(reg!.report.clear).toBe(true); // never conflicts with itself

    const stored = await readPlan(root, 'sess-a', now + 20);
    expect(stored!.areas).toContain('app/src/one.ts');
    expect(stored!.areas).toContain('app/src/two.ts');
    expect(stored!.summary).toBe('A v2');
  });

  it('honors custom coord.spec_patterns from the manifest', async () => {
    const toml = `${MANIFEST}
[coord]
spec_patterns = ["rfcs/*.md"]
`;
    const { root, manifest } = await freshWs(toml);
    await mkdir(join(root, 'rfcs'), { recursive: true });
    await mkdir(join(root, 'plans'), { recursive: true });
    await writeFile(join(root, 'rfcs', '001.md'), '# RFC 001\n\n`app/src/x.ts`', 'utf8');
    await writeFile(join(root, 'plans', 'p.md'), '# P\n\n`app/src/y.ts`', 'utf8');

    expect(await registerSpec(root, manifest, 's', join(root, 'rfcs', '001.md'), Date.now())).not.toBeNull();
    expect(await registerSpec(root, manifest, 's', join(root, 'plans', 'p.md'), Date.now())).toBeNull(); // defaults replaced
  });
});

describe('planDeclare()', () => {
  it('does not throw on a missing or non-spec file', async () => {
    const { root } = await freshWs();
    await planDeclare(join(root, 'repolith.toml'), join(root, 'plans', 'missing.md'), {});
    await writeFile(join(root, 'nope.md'), 'x', 'utf8');
    await planDeclare(join(root, 'repolith.toml'), join(root, 'nope.md'), {});
  });

  it('registers with source "declare" under the given session id', async () => {
    const { root } = await freshWs();
    await mkdir(join(root, 'specs'), { recursive: true });
    await writeFile(join(root, 'specs', 's.md'), '# S\n\n`app/src/z.ts`', 'utf8');
    await planDeclare(join(root, 'repolith.toml'), join(root, 'specs', 's.md'), { session: 'sess-x' });
    const stored = await readPlan(root, 'sess-x', Date.now());
    expect(stored).not.toBeNull();
    expect(stored!.source).toBe('declare');
    expect(stored!.areas).toContain('app/src/z.ts');
  });
});
