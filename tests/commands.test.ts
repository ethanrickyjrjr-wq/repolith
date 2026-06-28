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
import { execCommand } from '../src/commands/exec';

let remoteDir: string;
let wsDir: string;
let manifestPath: string;
const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

beforeAll(async () => {
  remoteDir = await mkdtemp(join(tmpdir(), 'ws-cmd-remote-'));
  await execa('git', ['init', '--bare', remoteDir]);
  const tmp = await mkdtemp(join(tmpdir(), 'ws-cmd-tmp-'));
  await execa('git', ['clone', remoteDir, tmp]);
  await writeFile(join(tmp, 'app.ts'), '// TODO: build the thing\nexport const x = 1;\n');
  await execa('git', [...IDENTITY, 'add', '-A'], { cwd: tmp });
  await execa('git', [...IDENTITY, 'commit', '-m', 'initial commit'], { cwd: tmp });
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: tmp });
  await rm(tmp, { recursive: true });

  wsDir = await mkdtemp(join(tmpdir(), 'ws-cmd-ws-'));
  const url = remoteDir.replace(/\\/g, '/');
  manifestPath = join(wsDir, 'repolith.toml');
  await writeFile(manifestPath, [
    '[workspace]', 'name = "cmd-ws"', '',
    '[[repos]]', 'name = "hello"', `url = "${url}"`, 'path = "repos/hello"', 'ref = "main"', '',
  ].join('\n'));
  await syncCommand(manifestPath);
});

afterAll(async () => {
  await rm(remoteDir, { recursive: true });
  await rm(wsDir, { recursive: true });
});

// Capture console + stdout and neutralize process.exit so a command that
// calls exit(1) (grep no-match / diff dirty) can't kill the test runner.
function capture() {
  const out: string[] = [];
  const push = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  const log = spyOn(console, 'log').mockImplementation(push);
  const err = spyOn(console, 'error').mockImplementation(push);
  const w = spyOn(process.stdout, 'write').mockImplementation(((s: unknown) => { out.push(String(s)); return true; }) as never);
  const exit = spyOn(process, 'exit').mockImplementation(((() => undefined) as never));
  return {
    text: () => out.join('\n'),
    restore: () => { log.mockRestore(); err.mockRestore(); w.mockRestore(); exit.mockRestore(); },
  };
}

describe('command layer (against a synced workspace)', () => {
  it('status shows the repo on a clean main', async () => {
    const cap = capture();
    try { await statusCommand(manifestPath); } finally { cap.restore(); }
    const t = cap.text();
    expect(t).toContain('hello');
    expect(t).toContain('main');
    expect(t).toContain('clean');
  });

  it('grep finds a TODO and prefixes the repo name', async () => {
    const cap = capture();
    try { await grepCommand('TODO', [], manifestPath); } finally { cap.restore(); }
    const t = cap.text();
    expect(t).toContain('[hello]');
    expect(t).toContain('TODO');
  });

  it('grep with -l lists files (git grep flags must precede the pattern)', async () => {
    const cap = capture();
    try { await grepCommand('TODO', ['-l'], manifestPath); } finally { cap.restore(); }
    const t = cap.text();
    expect(t).toContain('[hello] app.ts');
    expect(t).not.toContain('TODO'); // -l prints filenames only, not the matched line
  });

  it('log shows the repo header and commit subject', async () => {
    const cap = capture();
    try { await logCommand(['-n', '5'], manifestPath); } finally { cap.restore(); }
    const t = cap.text();
    expect(t).toContain('=== [hello] ===');
    expect(t).toContain('initial commit');
  });

  it('diff is empty on a clean checkout', async () => {
    const cap = capture();
    try { await diffCommand([], manifestPath); } finally { cap.restore(); }
    expect(cap.text()).not.toContain('=== [hello] ===');
  });

  it('exec runs a command in each repo', async () => {
    const cap = capture();
    try { await execCommand('git rev-parse --abbrev-ref HEAD', manifestPath); } finally { cap.restore(); }
    const t = cap.text();
    expect(t).toContain('=== [hello] ===');
    expect(t).toContain('main');
  });
});
