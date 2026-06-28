import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

const color = (code: number, s: string): string =>
  process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const green = (s: string) => color(32, s);
const red = (s: string) => color(31, s);

interface RepoStatus { branch: string; dirty: boolean; ahead: number; behind: number; }

async function repoStatus(dest: string): Promise<RepoStatus> {
  const { stdout: branch } = await gitRun(dest, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const { stdout: porcelain } = await gitRun(dest, ['status', '--porcelain']);
  let ahead = 0;
  let behind = 0;
  try {
    const { stdout } = await gitRun(dest, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    const [b, a] = stdout.trim().split(/\s+/).map(Number);
    behind = b || 0;
    ahead = a || 0;
  } catch {
    // no upstream tracking branch configured — leave ahead/behind at 0
  }
  return { branch: branch.trim(), dirty: porcelain.trim().length > 0, ahead, behind };
}

export async function statusCommand(manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, (repo) =>
    repoStatus(join(manifestDir, repo.path)),
  );

  const nameWidth = Math.max(4, ...manifest.repos.map((r) => r.name.length));
  for (const r of results) {
    const name = r.repo.name.padEnd(nameWidth);
    if (!r.ok) {
      console.log(`${name}  ${red('ERROR')}: ${r.error.message}`);
      continue;
    }
    const { branch, dirty, ahead, behind } = r.value;
    const state = dirty ? red('dirty') : green('clean');
    const track = [ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ');
    console.log(`${name}  ${branch.padEnd(20)}  ${state}  ${track}`.trimEnd());
  }
}
