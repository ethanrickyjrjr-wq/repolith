import { describe, it, expect } from 'bun:test';
import { selfInvocation } from '../src/coord/invocation';

describe('selfInvocation', () => {
  it('source run (bun run …/src/cli.ts) → suggests the same bun invocation', () => {
    const argv = ['/path/to/bun', 'C:/dev/ws/src/cli.ts', 'edit-hook'];
    expect(selfInvocation(argv, {})).toBe('bun run C:/dev/ws/src/cli.ts');
  });

  it('normalizes a Windows backslash path to forward slashes (the verified-working hook-command form)', () => {
    const argv = ['bun.exe', 'C:\\dev\\ws\\src\\cli.ts', 'edit-hook'];
    expect(selfInvocation(argv, {})).toBe('bun run C:/dev/ws/src/cli.ts');
  });

  it('installed bin (dist/cli.js) → suggests the `repolith` bin', () => {
    const argv = ['node', 'C:/Users/dev/AppData/Roaming/npm/node_modules/repolith/dist/cli.js', 'edit-hook'];
    expect(selfInvocation(argv, {})).toBe('repolith');
  });

  it('REPOLITH_BIN overrides the heuristic', () => {
    const argv = ['node', '/whatever/dist/cli.js'];
    expect(selfInvocation(argv, { REPOLITH_BIN: 'repolith-dev' })).toBe('repolith-dev');
  });

  it('ignores a blank REPOLITH_BIN', () => {
    const argv = ['bun', '/x/src/cli.ts'];
    expect(selfInvocation(argv, { REPOLITH_BIN: '   ' })).toBe('bun run /x/src/cli.ts');
  });
});
