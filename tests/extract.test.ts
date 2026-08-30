import { describe, it, expect } from 'bun:test';
import { extractAreas, firstLine } from '../src/coord/extract';

describe('extractAreas()', () => {
  it('pulls globs and paths from prose + backtick spans', () => {
    const plan = '# Wire the dock\n\nRefactor `src/assistant/**` and edit src/api/assistant.ts to call it.';
    const areas = extractAreas(plan);
    expect(areas).toContain('src/assistant/**');
    expect(areas).toContain('src/api/assistant.ts');
  });

  it('ignores URLs and prose slashes like "and/or"', () => {
    const plan = 'See https://example.com/docs/guide and decide and/or proceed on src/x.ts.';
    const areas = extractAreas(plan);
    expect(areas.some((a) => a.includes('example.com'))).toBe(false);
    expect(areas).not.toContain('and/or');
    expect(areas).toContain('src/x.ts');
  });

  it('rejects date strings that look path-shaped (dogfood 01b bug)', () => {
    const plan =
      'Ship by `06/30/2026` (format MM/DD/YYYY, also 2026/07/01) — touch `src/coord/extract.ts` and 12/25/2026 too.';
    const areas = extractAreas(plan);
    expect(areas).not.toContain('06/30/2026');
    expect(areas).not.toContain('MM/DD/YYYY');
    expect(areas).not.toContain('2026/07/01');
    expect(areas).not.toContain('12/25/2026');
    expect(areas).toContain('src/coord/extract.ts');
  });

  it('still keeps numeric-ish real paths (extension or glob present)', () => {
    const areas = extractAreas('Rotate `logs/2026/07/01.log` and `data/2026/**`.');
    expect(areas).toContain('logs/2026/07/01.log');
    expect(areas).toContain('data/2026/**');
  });

  it('empty / undefined plan → []', () => {
    expect(extractAreas('')).toEqual([]);
    expect(extractAreas(undefined)).toEqual([]);
  });
});

describe('firstLine()', () => {
  it('strips a heading marker', () => {
    expect(firstLine('# My Plan\nbody')).toBe('My Plan');
  });
  it('skips blank lines', () => {
    expect(firstLine('\n\n  real line  \n')).toBe('real line');
  });
  it('undefined → empty string', () => {
    expect(firstLine(undefined)).toBe('');
  });
});
