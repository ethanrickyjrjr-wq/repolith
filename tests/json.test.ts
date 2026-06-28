import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { syncCommand } from '../src/commands/sync';
import { statusCommand } from '../src/commands/status';
import { grepCommand } from '../src/commands/grep';
import { logCommand } from '../src/commands/log';
import { diffCommand } from '../src/commands/diff';
import { stateCommand } from '../src/commands/freeze';

let remoteDir: string;
let wsDir: string;
let manifestPath: string;
const ID = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

beforeAll(async () => {
  remoteDir = await mkdtemp(join(tmpdir(), 'ws-json-remote-'));
  await execa('git', ['init', '--bare', remoteDir]);
  const tmp = await mkdtemp(join(tmpdir(), 'ws-json-tmp-'));
  await execa('git', ['clone', remoteDir, tmp]);
  await writeFile(join(tmp, 'app.ts'), '// TODO: ship it\n');
  await execa('git', [...ID, 'add', '-A'], { cwd: tmp });
  await execa('git', [...ID, 'commit', '-m', 'initial commit'], { cwd: tmp });
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: tmp });
  await rm(tmp, { recursive: true });

  wsDir = await mkdtemp(join(tmpdir(), 'ws-json-ws-'));
  manifestPath = join(wsDir, 'repolith.toml');
  await writeFile(manifestPath, [
    '[workspace]', 'name = "json-ws"', '',
    '[[repos]]', 'name = "hello"', `url = "${remoteDir.replace(/\\/g, '/')}"`, 'path = "repos/hello"', 'ref = "main"', '',
  ].join('\n'));
  await syncCommand(manifestPath);
});

afterAll(async () => {
  await rm(remoteDir, { recursive: true });
  await rm(wsDir, { recursive: true });
});

// capture console.log (the single JSON.stringify call) and neutralize process.exit
function captureJson() {
  const out: string[] = [];
  const log = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { out.push(a.map(String).join(' ')); });
  const exit = spyOn(process, 'exit').mockImplementation(((() => undefined) as never));
  return {
    parsed: () => JSON.parse(out.join('\n')),
    restore: () => { log.mockRestore(); exit.mockRestore(); },
  };
}

describe('--json output', () => {
  it('status --json is a parseable array with branch + clean flag', async () => {
    const cap = captureJson();
    try { await statusCommand(manifestPath, true); } finally { cap.restore(); }
    const data = cap.parsed();
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].repo).toBe('hello');
    expect(data[0].branch).toBe('main');
    expect(data[0].dirty).toBe(false);
  });

  it('grep --json groups hits by repo', async () => {
    const cap = captureJson();
    try { await grepCommand('TODO', [], manifestPath, true); } finally { cap.restore(); }
    const data = cap.parsed();
    expect(data[0].repo).toBe('hello');
    expect(data[0].hits.join('\n')).toContain('TODO');
  });

  it('log --json includes the commit subject', async () => {
    const cap = captureJson();
    try { await logCommand(['-n', '5'], manifestPath, true); } finally { cap.restore(); }
    const data = cap.parsed();
    expect(data[0].log).toContain('initial commit');
  });

  it('diff --json is empty on a clean checkout', async () => {
    const cap = captureJson();
    try { await diffCommand([], manifestPath, true); } finally { cap.restore(); }
    const data = cap.parsed();
    expect(data[0].diff).toBe('');
  });

  it('state --json exposes the atomic hash', async () => {
    const cap = captureJson();
    try { await stateCommand(manifestPath, true); } finally { cap.restore(); }
    const data = cap.parsed();
    expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(data.repos.hello.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});
