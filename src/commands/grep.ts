import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export async function grepCommand(pattern: string, extraArgs: string[], manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    // git grep exits 1 when no matches — that's not an error for us
    const { stdout } = await gitRun(dest, ['grep', '--color=never', '-n', pattern, ...extraArgs])
      .catch(() => ({ stdout: '', stderr: '' }));
    return stdout;
  });

  let anyMatch = false;
  for (const r of results) {
    if (!r.ok || !r.value.trim()) continue;
    const lines = r.value.trim().split('\n');
    for (const line of lines) {
      console.log(`[${r.repo.name}] ${line}`);
      anyMatch = true;
    }
  }

  if (!anyMatch) process.exit(1);
}
