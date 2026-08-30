import { describe, it, expect } from 'bun:test';
import { renderSemanticCheck, type SemanticPlanView } from '../src/coord/semantic';

const A: SemanticPlanView = {
  session_id: 'A',
  summary: 'rename authenticate() → verifySession() in auth.ts',
  areas: ['src/auth.ts'],
  plan_excerpt: 'Rename the exported authenticate() to verifySession() and update its callers.',
};
const B: SemanticPlanView = {
  session_id: 'B',
  summary: 'wire billing to the auth check',
  areas: ['src/billing.ts'],
  plan_excerpt: 'Import authenticate() from ../auth and gate the invoice route on it.',
};

describe('renderSemanticCheck()', () => {
  it('null when there is no other active session', () => {
    expect(renderSemanticCheck(A, [])).toBeNull();
    expect(renderSemanticCheck(A, [A])).toBeNull(); // only me
  });

  it('fires on the path-DISJOINT-but-coupled case (the whole reason it exists)', () => {
    // A owns src/auth.ts, B owns src/billing.ts — zero path overlap.
    const block = renderSemanticCheck(A, [B]);
    expect(block).not.toBeNull();
    expect(block).toContain('semantic cross-check');
    expect(block).toContain('B'); // names the peer session
    expect(block).toContain('wire billing to the auth check'); // its intent
    expect(block).toContain('rename'); // the checklist prompt
  });

  it('carries each peer summary, areas, and a trimmed intent excerpt', () => {
    const block = renderSemanticCheck(A, [B])!;
    expect(block).toContain('areas: src/billing.ts');
    expect(block).toContain('intent: Import authenticate()');
  });

  it('excludes peers with no substantive plan', () => {
    const empty: SemanticPlanView = { session_id: 'C', summary: '   ', areas: [], plan_excerpt: '' };
    expect(renderSemanticCheck(A, [empty])).toBeNull();
    // ...but a peer with only a summary (no excerpt/areas) still counts.
    const summaryOnly: SemanticPlanView = { session_id: 'D', summary: 'refactor the router' };
    expect(renderSemanticCheck(A, [summaryOnly])).toContain('refactor the router');
  });

  it('never adjudicates — the block is explicitly advisory', () => {
    const block = renderSemanticCheck(A, [B])!;
    expect(block.toLowerCase()).toContain('advisory');
    expect(block).toContain('you decide');
  });

  it('truncates a long excerpt with an ellipsis', () => {
    const long: SemanticPlanView = { session_id: 'E', summary: 's', plan_excerpt: 'x'.repeat(500) };
    const block = renderSemanticCheck(A, [long])!;
    expect(block).toContain('…');
    expect(block).not.toContain('x'.repeat(300)); // not the whole 500-char body
  });

  it('caps the peer list and reports the remainder', () => {
    const many: SemanticPlanView[] = Array.from({ length: 9 }, (_, i) => ({
      session_id: `S${i}`,
      summary: `task ${i}`,
    }));
    const block = renderSemanticCheck(A, many)!;
    expect(block).toContain('9 other active sessions');
    expect(block).toContain('and 3 more'); // 9 peers, MAX_OTHERS = 6
  });
});
