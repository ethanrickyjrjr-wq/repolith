// snapshotPush (finding 11) — the module both prior leaks lived in, previously untested.
// The spawn/timeout seams (PushDeps) let every path run without PowerShell or a live
// Blob upload: throttle window, lock-file claim, kill-on-timeout, spawn error, opt-outs.
import { describe, it, expect, afterAll, beforeEach, afterEach } from 'bun:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pushSnapshot, PUSH_URGENT_MS, type PushDeps } from '../src/coord/snapshotPush';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-push-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

interface FakeChild extends EventEmitter {
  kill: () => void;
  killed: boolean;
}
function fakeChild(): FakeChild {
  const c = new EventEmitter() as FakeChild;
  c.killed = false;
  c.kill = () => {
    c.killed = true;
  };
  return c;
}

/** A spawnFn that records calls and immediately "exits" its child (unless told to hang). */
function fakeSpawn(opts: { hang?: boolean } = {}): { deps: PushDeps; calls: string[][]; children: FakeChild[] } {
  const calls: string[][] = [];
  const children: FakeChild[] = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push([cmd, ...args]);
    const child = fakeChild();
    children.push(child);
    if (!opts.hang) setTimeout(() => child.emit('exit', 0), 0);
    return child;
  }) as unknown as PushDeps['spawnFn'];
  return { deps: { spawnFn, timeoutMs: 100, scriptPath: import.meta.path }, calls, children };
}

// Other test files set the opt-out globally (spec-hook.test.ts) and bun runs files in one
// process — save/restore around each test so this file controls its own env, and later
// files keep whatever they relied on.
let savedOptOut: string | undefined;
beforeEach(() => {
  savedOptOut = process.env['REPOLITH_NO_SNAPSHOT_PUSH'];
  delete process.env['REPOLITH_NO_SNAPSHOT_PUSH'];
});
afterEach(() => {
  if (savedOptOut === undefined) delete process.env['REPOLITH_NO_SNAPSHOT_PUSH'];
  else process.env['REPOLITH_NO_SNAPSHOT_PUSH'] = savedOptOut;
});

const isWin = process.platform === 'win32';

describe('coord snapshotPush', () => {
  it('REPOLITH_NO_SNAPSHOT_PUSH opt-out never spawns and never writes the lock', async () => {
    const root = await freshRoot();
    process.env['REPOLITH_NO_SNAPSHOT_PUSH'] = '1';
    const f = fakeSpawn();
    await pushSnapshot(root, PUSH_URGENT_MS, f.deps);
    expect(f.calls.length).toBe(0);
    await expect(stat(join(root, '.repolith', '.blob-push-ts'))).rejects.toThrow();
  });

  it.if(isWin)('no uploader script on this machine → no spawn, no lock (the npm-install / fresh-clone path)', async () => {
    const root = await freshRoot();
    const f = fakeSpawn();
    await pushSnapshot(root, PUSH_URGENT_MS, { ...f.deps, scriptPath: join(root, 'does-not-exist.ps1') });
    expect(f.calls.length).toBe(0);
    await expect(stat(join(root, '.repolith', '.blob-push-ts'))).rejects.toThrow();
  });

  it.if(isWin)('first push spawns the uploader once and claims the throttle lock', async () => {
    const root = await freshRoot();
    const f = fakeSpawn();
    await pushSnapshot(root, PUSH_URGENT_MS, f.deps);
    expect(f.calls.length).toBe(1);
    expect(f.calls[0][0]).toBe('powershell');
    expect(f.calls[0].some((a) => a === import.meta.path)).toBe(true); // runs the injected uploader path
    // Lock claimed BEFORE the upload ran, so concurrent hooks don't all fire.
    const lock = await readFile(join(root, '.repolith', '.blob-push-ts'), 'utf8');
    expect(Number.isNaN(Date.parse(lock))).toBe(false); // ISO timestamp
  });

  it.if(isWin)('a second push inside the throttle window is skipped', async () => {
    const root = await freshRoot();
    const f = fakeSpawn();
    await pushSnapshot(root, 60_000, f.deps);
    await pushSnapshot(root, 60_000, f.deps);
    expect(f.calls.length).toBe(1); // throttled — no second spawn
  });

  it.if(isWin)('a hung uploader is killed at timeoutMs and the hook is released', async () => {
    const root = await freshRoot();
    const f = fakeSpawn({ hang: true });
    const t0 = Date.now();
    await pushSnapshot(root, PUSH_URGENT_MS, f.deps); // must resolve despite no exit event
    expect(Date.now() - t0).toBeLessThan(5_000); // bounded by timeoutMs (100), not UPLOAD_TIMEOUT_MS
    expect(f.children[0].killed).toBe(true);
  });

  it.if(isWin)('a throwing spawn never throws out of pushSnapshot', async () => {
    const root = await freshRoot();
    const deps: PushDeps = {
      spawnFn: (() => {
        throw new Error('ENOENT: powershell missing');
      }) as unknown as PushDeps['spawnFn'],
      timeoutMs: 100,
      scriptPath: import.meta.path,
    };
    await pushSnapshot(root, PUSH_URGENT_MS, deps); // resolves — advisory, never breaks a hook
  });

  it.if(isWin)('a child error event resolves the push instead of hanging it', async () => {
    const root = await freshRoot();
    const calls: string[][] = [];
    const child = fakeChild();
    const deps: PushDeps = {
      spawnFn: ((cmd: string, args: string[]) => {
        calls.push([cmd, ...args]);
        setTimeout(() => child.emit('error', new Error('spawn failed')), 0);
        return child;
      }) as unknown as PushDeps['spawnFn'],
      timeoutMs: 5_000,
      scriptPath: import.meta.path,
    };
    const t0 = Date.now();
    await pushSnapshot(root, PUSH_URGENT_MS, deps);
    expect(Date.now() - t0).toBeLessThan(4_000); // resolved on 'error', not the timeout
    expect(calls.length).toBe(1);
  });
});
