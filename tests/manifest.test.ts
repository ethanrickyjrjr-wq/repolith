import { describe, it, expect } from 'bun:test';
import { parseManifest } from '../src/manifest';

const VALID = `
[workspace]
name = "my-workspace"

[[repos]]
name = "frontend"
url = "https://github.com/org/frontend.git"
path = "packages/frontend"
ref = "main"

[[repos]]
name = "backend"
url = "https://github.com/org/backend.git"
path = "packages/backend"
ref = "main"
`;

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const m = parseManifest(VALID);
    expect(m.name).toBe('my-workspace');
    expect(m.repos).toHaveLength(2);
    expect(m.repos[0]).toEqual({
      name: 'frontend',
      url: 'https://github.com/org/frontend.git',
      path: 'packages/frontend',
      ref: 'main',
    });
  });

  it('throws when workspace.name is missing', () => {
    expect(() => parseManifest(`[[repos]]\nname="a"\nurl="u"\npath="p"\nref="r"`))
      .toThrow('workspace.name');
  });

  it('throws when a repo is missing required fields', () => {
    expect(() => parseManifest(`[workspace]\nname="ws"\n[[repos]]\nname="a"`))
      .toThrow('repos[0]');
  });

  it('throws on duplicate repo names', () => {
    const dup = `[workspace]\nname="ws"\n[[repos]]\nname="a"\nurl="u"\npath="p"\nref="r"\n[[repos]]\nname="a"\nurl="u2"\npath="p2"\nref="r"`;
    expect(() => parseManifest(dup)).toThrow('duplicate');
  });
});
