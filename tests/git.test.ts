import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { gitClone, gitCurrentCommit, gitRun } from '../src/git';

// Create a bare local repo to clone from (no network needed)
let remoteDir: string;
let workDir: string;

const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

beforeAll(async () => {
  remoteDir = await mkdtemp(join(tmpdir(), 'ws-remote-'));
  workDir   = await mkdtemp(join(tmpdir(), 'ws-work-'));
  // init bare repo
  await execa('git', ['init', '--bare', remoteDir]);
  // create a commit in a temp clone
  const tmp = await mkdtemp(join(tmpdir(), 'ws-tmp-'));
  await execa('git', ['clone', remoteDir, tmp]);
  await execa('git', [...IDENTITY, 'commit', '--allow-empty', '-m', 'init'], { cwd: tmp });
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: tmp });
  await rm(tmp, { recursive: true });
});

afterAll(async () => {
  await rm(remoteDir, { recursive: true });
  await rm(workDir,   { recursive: true });
});

describe('gitClone + gitCurrentCommit', () => {
  it('clones a repo and returns a 40-char SHA', async () => {
    const dest = join(workDir, 'cloned');
    await gitClone(remoteDir, dest, 'main');
    const sha = await gitCurrentCommit(dest);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('gitRun', () => {
  it('runs an arbitrary git command in the repo dir', async () => {
    const dest = join(workDir, 'cloned');
    const { stdout } = await gitRun(dest, ['log', '--oneline', '-1']);
    expect(stdout.trim()).toMatch(/init/);
  });
});
