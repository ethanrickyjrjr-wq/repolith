import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { syncCommand } from '../src/commands/sync';
import { checkoutCommand } from '../src/commands/checkout';
import { gitCheckoutCommit, gitCurrentCommit } from '../src/git';

let remoteDir: string;
let wsDir: string;
let manifestPath: string;
let repoDir: string;
let sha1: string; // first (older) commit
let sha2: string; // second commit (= HEAD, what sync locks)
const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

beforeAll(async () => {
  remoteDir = await mkdtemp(join(tmpdir(), 'ws-co-remote-'));
  await execa('git', ['init', '--bare', remoteDir]);
  const tmp = await mkdtemp(join(tmpdir(), 'ws-co-tmp-'));
  await execa('git', ['clone', remoteDir, tmp]);
  await writeFile(join(tmp, 'f.txt'), 'one\n');
  await execa('git', [...IDENTITY, 'add', '-A'], { cwd: tmp });
  await execa('git', [...IDENTITY, 'commit', '-m', 'one'], { cwd: tmp });
  sha1 = (await execa('git', ['rev-parse', 'HEAD'], { cwd: tmp })).stdout.trim();
  await writeFile(join(tmp, 'f.txt'), 'two\n');
  await execa('git', [...IDENTITY, 'commit', '-am', 'two'], { cwd: tmp });
  sha2 = (await execa('git', ['rev-parse', 'HEAD'], { cwd: tmp })).stdout.trim();
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: tmp });
  await rm(tmp, { recursive: true });

  wsDir = await mkdtemp(join(tmpdir(), 'ws-co-ws-'));
  manifestPath = join(wsDir, 'repolith.toml');
  repoDir = join(wsDir, 'repos', 'hello');
  const url = remoteDir.replace(/\\/g, '/');
  await writeFile(manifestPath, [
    '[workspace]', 'name = "co-ws"', '',
    '[[repos]]', 'name = "hello"', `url = "${url}"`, 'path = "repos/hello"', 'ref = "main"', '',
  ].join('\n'));
  await syncCommand(manifestPath); // clones at HEAD (sha2), writes lockfile
});

afterAll(async () => {
  await rm(remoteDir, { recursive: true });
  await rm(wsDir, { recursive: true });
});

function muteExit() {
  return spyOn(process, 'exit').mockImplementation(((() => undefined) as never));
}

describe('checkoutCommand', () => {
  it('locked the HEAD commit on sync', async () => {
    const lock = JSON.parse(await readFile(join(wsDir, 'repolith.lock.json'), 'utf8'));
    expect(lock.repos.hello.commit).toBe(sha2);
  });

  it('restores a repo that has moved off the locked commit', async () => {
    // move the working repo back to the older commit
    await gitCheckoutCommit(repoDir, sha1);
    expect(await gitCurrentCommit(repoDir)).toBe(sha1);

    const exit = muteExit();
    try {
      await checkoutCommand(manifestPath);
    } finally {
      exit.mockRestore();
    }

    // restored to the locked commit
    expect(await gitCurrentCommit(repoDir)).toBe(sha2);
  });

  it('throws when there is no lockfile', async () => {
    const emptyWs = await mkdtemp(join(tmpdir(), 'ws-co-empty-'));
    await writeFile(join(emptyWs, 'repolith.toml'), [
      '[workspace]', 'name = "x"', '',
      '[[repos]]', 'name = "a"', 'url = "u"', 'path = "p"', 'ref = "main"', '',
    ].join('\n'));
    await expect(checkoutCommand(join(emptyWs, 'repolith.toml'))).rejects.toThrow('no repolith.lock.json');
    await rm(emptyWs, { recursive: true });
  });
});
