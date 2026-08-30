import { describe, it, expect } from 'bun:test';
import { parseGrants, hasGrant } from '../src/grants';

describe('grants', () => {
  it('parses per-agent tool grants', () => {
    const grants = parseGrants(
      ['[agents.alice]', 'checkout = true', '', '[agents.bob]', 'checkout = false', ''].join('\n'),
    );
    expect(hasGrant(grants, 'alice', 'checkout')).toBe(true);
    expect(hasGrant(grants, 'bob', 'checkout')).toBe(false);
  });

  it('defaults to no grant for an unknown agent or an unlisted tool', () => {
    const grants = parseGrants('[agents.alice]\ncheckout = true\n');
    expect(hasGrant(grants, 'carol', 'checkout')).toBe(false);
    expect(hasGrant(grants, 'alice', 'exec')).toBe(false);
  });

  it('treats an empty document as nobody having any grant', () => {
    expect(hasGrant(parseGrants(''), 'alice', 'checkout')).toBe(false);
  });

  it('rejects a non-boolean grant value', () => {
    expect(() => parseGrants('[agents.alice]\ncheckout = "yes"\n')).toThrow();
  });

  it('rejects a non-table agent entry', () => {
    expect(() => parseGrants('[agents]\nalice = "oops"\n')).toThrow();
  });
});
