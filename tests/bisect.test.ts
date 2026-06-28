import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { syncCommand } from '../src/commands/sync';
import { bisect } from '../src/commands/bisect';
import { computeHash } from '../src/lockfile';

let remoteA: string;
let remoteB: string;
let wsDir: string;
let manifestPath: string;
let goodLockPath: string;
let aGood: string;
let bBad: string;
const ID = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

// commit with a controlled committer date so the merged timeline order is deterministic
async function commit(cwd: string, file: string, content: string, msg: string, date: string): Promise<string> {
  await writeFile(join(cwd, file), content);
  await execa('git', [...ID, 'add', '-A'], { cwd });
  await execa('git', [...ID, 'commit', '-m', msg], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return (await execa('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();
}

async function makeRepo(prefix: string): Promise<{ remote: string; clone: string }> {
  const remote = await mkdtemp(join(tmpdir(), `${prefix}-remote-`));
  await execa('git', ['init', '--bare', remote]);
  const clone = await mkdtemp(join(tmpdir(), `${prefix}-clone-`));
  await execa('git', ['clone', remote, clone]);
  return { remote, clone };
}

let aGoodSha = '';
let bBadSha = '';

beforeAll(async () => {
  const a = await makeRepo('ws-bi-a');
  const b = await makeRepo('ws-bi-b');
  remoteA = a.remote;
  remoteB = b.remote;

  // repo A: good @ 01-01, then an INNOCENT change @ 01-03
  aGoodSha = await commit(a.clone, 'src.txt', 'ok\n', 'a: base', '2020-01-01T00:00:00');
  await commit(a.clone, 'src.txt', 'ok-more\n', 'a: innocent tweak', '2020-01-03T00:00:00');
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: a.clone });

  // repo B: good @ 01-02, then the BUG @ 01-04 (latest in the timeline)
  const bGoodSha = await commit(b.clone, 'src.txt', 'ok\n', 'b: base', '2020-01-02T00:00:00');
  bBadSha = await commit(b.clone, 'src.txt', 'BROKEN\n', 'b: introduce the bug', '2020-01-04T00:00:00');
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: b.clone });

  await rm(a.clone, { recursive: true });
  await rm(b.clone, { recursive: true });
  aGood = aGoodSha;
  bBad = bBadSha;

  // workspace: sync clones both at HEAD (the "bad" current state)
  wsDir = await mkdtemp(join(tmpdir(), 'ws-bi-ws-'));
  manifestPath = join(wsDir, 'repolith.toml');
  await writeFile(manifestPath, [
    '[workspace]', 'name = "bi-ws"', '',
    '[[repos]]', 'name = "a"', `url = "${remoteA.replace(/\\/g, '/')}"`, 'path = "repos/a"', 'ref = "main"', '',
    '[[repos]]', 'name = "b"', `url = "${remoteB.replace(/\\/g, '/')}"`, 'path = "repos/b"', 'ref = "main"', '',
  ].join('\n'));
  await syncCommand(manifestPath);

  // a known-good lockfile pinning the base commits of both repos
  const goodRepos = {
    a: { url: remoteA, ref: 'main', commit: aGoodSha },
    b: { url: remoteB, ref: 'main', commit: bGoodSha },
  };
  goodLockPath = join(wsDir, 'good.lock.json');
  await writeFile(goodLockPath, JSON.stringify({ version: 1, repos: goodRepos, hash: computeHash(goodRepos) }));

  // cross-platform test: fails (exit 1) iff any repo's src.txt contains BROKEN
  await writeFile(join(wsDir, 'check.mjs'), [
    "import { readFileSync } from 'node:fs';",
    "const bad = ['repos/a/src.txt', 'repos/b/src.txt'].some(p => {",
    '  try { return readFileSync(p, "utf8").includes("BROKEN"); } catch { return false; }',
    '});',
    'process.exit(bad ? 1 : 0);',
  ].join('\n'));
});

afterAll(async () => {
  await rm(remoteA, { recursive: true });
  await rm(remoteB, { recursive: true });
  await rm(wsDir, { recursive: true });
});

describe('cross-repo bisect', () => {
  it('blames the bug commit in repo b, not the innocent later state in repo a', async () => {
    const res = await bisect({ manifestPath, goodLockPath, test: 'node check.mjs' });
    expect(res.timelineLength).toBe(2);
    expect(res.culprit).not.toBeNull();
    expect(res.culprit!.repo).toBe('b');
    expect(res.culprit!.commit).toBe(bBad);
    expect(res.culprit!.subject).toContain('introduce the bug');
  });

  it('errors when the test passes at the current state (nothing to bisect)', async () => {
    // a test that always passes
    await expect(bisect({ manifestPath, goodLockPath, test: 'node -e "process.exit(0)"' }))
      .rejects.toThrow('nothing to bisect');
  });
});
