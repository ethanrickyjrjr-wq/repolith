// cleanContext (finding 10) — the one gate between store-sourced text and a peer
// session's injected context. ANSI/OSC sequences must vanish whole (no "[31m"
// residue), control chars must not fake line boundaries, and length is bounded.
import { describe, it, expect } from 'bun:test';
import { cleanContext } from '../src/coord/sanitize';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

describe('cleanContext', () => {
  it('strips CSI color/clear sequences without leaking their printable tail', () => {
    expect(cleanContext(`a${ESC}[31mRED${ESC}[0m b`)).toBe('aRED b');
    expect(cleanContext(`${ESC}[2J${ESC}[H wiped`)).toBe('wiped');
  });

  it('strips OSC (terminal title) sequences through their BEL terminator', () => {
    expect(cleanContext(`${ESC}]0;evil-title${BEL}x`)).toBe('x');
  });

  it('collapses newlines/CR/tab/NUL to spaces so one record cannot fake extra lines', () => {
    expect(cleanContext('line1\r\nline2\tend !')).toBe('line1 line2 end !');
  });

  it('caps length with an ellipsis', () => {
    const out = cleanContext('x'.repeat(400), 300);
    expect(out.length).toBe(301);
    expect(out.endsWith('…')).toBe(true);
  });

  it('leaves ordinary text (unicode included) alone', () => {
    expect(cleanContext('fix éàü — src/auth.ts ×2')).toBe('fix éàü — src/auth.ts ×2');
  });
});
