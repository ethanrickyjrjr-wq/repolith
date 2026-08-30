import { describe, it, expect } from 'bun:test';
import { overlap, compareAgainstActive } from '../src/coord/overlap';

describe('overlap()', () => {
  it('recursive glob over a file inside it → hard', () => {
    expect(overlap('src/assistant/**', 'src/assistant/dock.tsx')).toBe('hard');
  });
  it('two files in the same directory → soft', () => {
    expect(overlap('src/assistant/dock.tsx', 'src/assistant/panel.tsx')).toBe('soft');
  });
  it('same shared-surface file in both → shared-surface', () => {
    expect(overlap('src/types.ts', 'src/types.ts')).toBe('shared-surface');
  });
  it('disjoint globs → null (no false positive)', () => {
    expect(overlap('src/api/**', 'src/ui/**')).toBeNull();
  });
  it('broad recursive glob subsumes a deep file → hard', () => {
    expect(overlap('src/**', 'src/api/x.ts')).toBe('hard');
  });
  it('same exact file → hard', () => {
    expect(overlap('src/a.ts', 'src/a.ts')).toBe('hard');
  });
  it('nested recursive globs overlap → hard', () => {
    expect(overlap('src/**', 'src/api/**')).toBe('hard');
  });
  it('shared-surface label wins over a plain hard overlap', () => {
    expect(overlap('src/**', 'src/types.ts')).toBe('shared-surface');
  });
  it('empty input → null', () => {
    expect(overlap('', 'src/a.ts')).toBeNull();
  });
});

describe('compareAgainstActive()', () => {
  const A = { session_id: 'A', summary: 'owns assistant', areas: ['src/assistant/**'] };

  it('clear when there are no other sessions', () => {
    expect(compareAgainstActive(A, [])).toEqual({ clear: true, conflicts: [] });
  });

  it('surfaces a hard conflict with a serialize recommendation', () => {
    const B = { session_id: 'B', summary: 'refactor dock', areas: ['src/assistant/dock.tsx'] };
    const r = compareAgainstActive(B, [A]);
    expect(r.clear).toBe(false);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].with_session).toBe('A');
    expect(r.conflicts[0].severity).toBe('hard');
    expect(r.conflicts[0].recommendation).toContain('serialize');
  });

  it('excludes self by session_id', () => {
    expect(compareAgainstActive(A, [A]).clear).toBe(true);
  });

  it('a hard same-file pair dominates a co-occurring shared-surface pair', () => {
    // regression: a same-file collision must not be masked when the same conflict
    // also touches a shared surface like types.ts (the live two-Sonnet run caught this).
    const me = { session_id: 'B', summary: '', areas: ['src/auth/session.ts', 'src/types.ts'] };
    const A = { session_id: 'A', summary: '', areas: ['src/auth/session.ts', 'src/types.ts'] };
    const r = compareAgainstActive(me, [A]);
    expect(r.conflicts[0].severity).toBe('hard');
    expect(r.conflicts[0].recommendation).toContain('serialize');
  });

  it('sorts shared-surface above soft', () => {
    const me = { session_id: 'me', summary: '', areas: ['src/types.ts', 'src/x/dock.tsx'] };
    const soft = { session_id: 'soft', summary: '', areas: ['src/x/panel.tsx'] };
    const shared = { session_id: 'shared', summary: '', areas: ['src/types.ts'] };
    const r = compareAgainstActive(me, [soft, shared]);
    expect(r.conflicts[0].severity).toBe('shared-surface');
  });
});
