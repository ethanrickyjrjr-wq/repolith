// session.ts (finding 11) — previously untested. renderSessionBrief is the pure core of
// the SessionStart catch-up hook; drive it both directly and through the real store
// (writePlan/claimFile → listActive/listClaims → render).
import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSessionBrief } from '../src/commands/session';
import { writePlan, listActive, type SessionPlan } from '../src/coord/store';
import { claimFile, listClaims, type Claim } from '../src/coord/claims';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-sesshook-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const NOW = Date.now();
const iso = (ms: number): string => new Date(ms).toISOString();

function plan(id: string, summary: string, areas: string[]): SessionPlan {
  return {
    session_id: id,
    workspace: 'demo',
    summary,
    areas,
    status: 'planning',
    started_at: iso(NOW),
    updated_at: iso(NOW),
    ttl_sec: 3600,
  };
}

function claim(file: string, id: string): Claim {
  return { file, session_id: id, claimed_at: iso(NOW), ttl_sec: 1800 };
}

describe('renderSessionBrief', () => {
  it('is silent (null) on a quiet workspace', () => {
    expect(renderSessionBrief([], [])).toBeNull();
  });

  it('renders sessions with a 3-area cap and claims with an 8-row cap', () => {
    const sessions = [plan('A', 'refactor auth', ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'])];
    const claims = Array.from({ length: 10 }, (_, i) => claim(`src/f${i}.ts`, 'A'));
    const out = renderSessionBrief(sessions, claims);
    expect(out).toContain('1 active session(s)');
    expect(out).toContain('A: refactor auth');
    expect(out).toContain('+2 more'); // 5 areas, 3 shown
    expect(out).toContain('10 active file claim(s)');
    expect(out).toContain('… and 2 more'); // 10 claims, 8 shown
    expect(out).toContain('src/f7.ts');
    expect(out).not.toContain('src/f9.ts'); // beyond the cap
  });

  it('claims-only and sessions-only workspaces still render', () => {
    expect(renderSessionBrief([], [claim('x.ts', 'B')])).toContain('x.ts  ←  B');
    expect(renderSessionBrief([plan('A', 'work', [])], [])).toContain('A: work');
  });

  it('sanitizes store-sourced text at the sink (finding 10)', () => {
    const esc = String.fromCharCode(27);
    const sessions = [plan('A', `evil${esc}[2J${esc}[31m\r\nsummary`, [`src${esc}[0m/x.ts`])];
    const out = renderSessionBrief(sessions, []) ?? '';
    expect(out).not.toContain(esc); // no escape byte survives
    expect(out).toContain('evil summary'); // controls collapsed to a space, content kept
  });

  it('renders from the real store round-trip', async () => {
    const root = await freshRoot();
    await writePlan(root, plan('sess-a', 'ship the dashboard', ['app/src/**']));
    await claimFile(root, 'app/src/page.tsx', 'sess-a', NOW);
    const [sessions, claims] = await Promise.all([listActive(root, NOW), listClaims(root, NOW)]);
    const out = renderSessionBrief(sessions, claims) ?? '';
    expect(out).toContain('sess-a: ship the dashboard');
    expect(out).toContain('app/src/page.tsx  ←  sess-a');
  });
});
