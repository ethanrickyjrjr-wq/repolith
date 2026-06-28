import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { syncCommand } from '../src/commands/sync';

// All tests use a local bare repo — no network.
let remoteDir: string;
let wsDir: string;
const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

beforeAll(async () => {
  remoteDir = await mkdtemp(join(tmpdir(), 'ws-sync-remote-'));
  await execa('git', ['init', '--bare', remoteDir]);
  const tmp = await mkdtemp(join(tmpdir(), 'ws-sync-tmp-'));
  await execa('git', ['clone', remoteDir, tmp]);
  await writeFile(join(tmp, 'hello.txt'), 'hi\n');
  await execa('git', [...IDENTITY, 'add', '-A'], { cwd: tmp });
  await execa('git', [...IDENTITY, 'commit', '-m', 'init'], { cwd: tmp });
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: tmp });
  await rm(tmp, { recursive: true });
});

afterAll(async () => {
  await rm(remoteDir, { recursive: true });
  if (wsDir) await rm(wsDir, { recursive: true });
});

describe('syncCommand', () => {
  it('clones repos and writes a lockfile with a 40-char commit + 64-char hash', async () => {
    wsDir = await mkdtemp(join(tmpdir(), 'ws-sync-ws-'));
    // forward slashes: valid for git on Windows AND avoids TOML escape pitfalls (\U etc.)
    const url = remoteDir.replace(/\\/g, '/');
    const manifest = [
      '[workspace]',
      'name = "test-ws"',
      '',
      '[[repos]]',
      'name = "hello"',
      `url = "${url}"`,
      'path = "repos/hello"',
      'ref = "main"',
      '',
    ].join('\n');
    const manifestPath = join(wsDir, 'repolith.toml');
    await writeFile(manifestPath, manifest);

    await syncCommand(manifestPath);

    // repo was actually cloned
    expect(existsSync(join(wsDir, 'repos', 'hello', 'hello.txt'))).toBe(true);

    // lockfile written next to the manifest
    const lock = JSON.parse(await readFile(join(wsDir, 'repolith.lock.json'), 'utf8'));
    expect(lock.version).toBe(1);
    expect(lock.repos.hello.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.repos.hello.ref).toBe('main');
    expect(lock.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent on a second run (fetch path, lockfile stable)', async () => {
    const lockPath = join(wsDir, 'repolith.lock.json');
    const before = await readFile(lockPath, 'utf8');
    await syncCommand(join(wsDir, 'repolith.toml'));
    const after = await readFile(lockPath, 'utf8');
    expect(after).toBe(before);
  });
});
