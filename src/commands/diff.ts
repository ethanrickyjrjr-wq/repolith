import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export async function diffCommand(extraArgs: string[], manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    const { stdout } = await gitRun(dest, ['diff', ...extraArgs]);
    return stdout;
  });

  let anyDiff = false;
  for (const r of results) {
    if (!r.ok) {
      console.error(`=== [${r.repo.name}] ERROR: ${r.error.message}`);
      continue;
    }
    if (r.value.trim()) {
      console.log(`\n=== [${r.repo.name}] ===`);
      process.stdout.write(r.value);
      anyDiff = true;
    }
  }

  if (anyDiff) process.exit(1);
}
