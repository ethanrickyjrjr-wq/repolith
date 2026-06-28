import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { syncCommand } from '../src/commands/sync';
import { buildState, freezeCommand } from '../src/commands/freeze';
import { openCommand } from '../src/commands/open';
import { gitCheckoutCommit, gitCurrentCommit } from '../src/git';

let remoteDir: string;
let wsDir: string;
let manifestPath: string;
let repoDir: string;
let sha0: string;
let sha1: string;
const ID = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

beforeAll(async () => {
  remoteDir = await mkdtemp(join(tmpdir(), 'ws-fo-remote-'));
  await execa('git', ['init', '--bare', remoteDir]);
  const tmp = await mkdtemp(join(tmpdir(), 'ws-fo-tmp-'));
  await execa('git', ['clone', remoteDir, tmp]);
  await writeFile(join(tmp, 'f.txt'), 'one\n');
  await execa('git', [...ID, 'add', '-A'], { cwd: tmp });
  await execa('git', [...ID, 'commit', '-m', 'one'], { cwd: tmp });
  sha0 = (await execa('git', ['rev-parse', 'HEAD'], { cwd: tmp })).stdout.trim();
  await writeFile(join(tmp, 'f.txt'), 'two\n');
  await execa('git', [...ID, 'commit', '-am', 'two'], { cwd: tmp });
  sha1 = (await execa('git', ['rev-parse', 'HEAD'], { cwd: tmp })).stdout.trim();
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: tmp });
  await rm(tmp, { recursive: true });

  wsDir = await mkdtemp(join(tmpdir(), 'ws-fo-ws-'));
  manifestPath = join(wsDir, 'repolith.toml');
  repoDir = join(wsDir, 'repos', 'hello');
  await writeFile(manifestPath, [
    '[workspace]', 'name = "fo-ws"', '',
    '[[repos]]', 'name = "hello"', `url = "${remoteDir.replace(/\\/g, '/')}"`, 'path = "repos/hello"', 'ref = "main"', '',
  ].join('\n'));
  await syncCommand(manifestPath); // clones at sha1
});

afterAll(async () => {
  await rm(remoteDir, { recursive: true });
  await rm(wsDir, { recursive: true });
});

describe('freeze / open', () => {
  it('buildState captures the current commit + a 64-char hash', async () => {
    const state = await buildState(manifestPath);
    expect(state.repos.hello.commit).toBe(sha1);
    expect(state.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('open restores the workspace from a frozen state file', async () => {
    const stateFile = join(wsDir, 'snap.json');
    await freezeCommand(manifestPath, stateFile); // captures sha1

    // move the repo off the frozen commit
    await gitCheckoutCommit(repoDir, sha0);
    expect(await gitCurrentCommit(repoDir)).toBe(sha0);

    const exit = spyOn(process, 'exit').mockImplementation(((() => undefined) as never));
    try {
      await openCommand(manifestPath, stateFile);
    } finally {
      exit.mockRestore();
    }

    expect(await gitCurrentCommit(repoDir)).toBe(sha1);
  });
});
