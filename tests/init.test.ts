import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initCommand, type Asker } from '../src/commands/init';
import { parseManifest } from '../src/manifest';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ws-init-')); });
afterEach(async () => { await rm(dir, { recursive: true }); });

// scripted prompt answers, in order; runs dry → '' once exhausted
const asker = (answers: string[]): Asker => {
  let i = 0;
  return async () => answers[i++] ?? '';
};

describe('initCommand', () => {
  it('writes a valid repolith.toml from scripted answers', async () => {
    await initCommand(dir, false, asker([
      'my-ws', 'frontend', 'https://github.com/org/frontend.git', 'packages/frontend', 'main', '',
    ]));
    const m = parseManifest(await readFile(join(dir, 'repolith.toml'), 'utf8'));
    expect(m.name).toBe('my-ws');
    expect(m.repos).toHaveLength(1);
    expect(m.repos[0]).toEqual({
      name: 'frontend',
      url: 'https://github.com/org/frontend.git',
      path: 'packages/frontend',
      ref: 'main',
    });
  });

  it('applies default path/ref when those answers are blank', async () => {
    await initCommand(dir, false, asker(['ws2', 'api', 'https://github.com/org/api.git', '', '', '']));
    const m = parseManifest(await readFile(join(dir, 'repolith.toml'), 'utf8'));
    expect(m.repos[0].path).toBe('repos/api');
    expect(m.repos[0].ref).toBe('main');
  });

  it('refuses to overwrite an existing manifest without --force', async () => {
    await writeFile(join(dir, 'repolith.toml'), 'x');
    await expect(initCommand(dir, false, asker([]))).rejects.toThrow('already exists');
  });
});
