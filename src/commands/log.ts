import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export async function logCommand(extraArgs: string[], manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    const { stdout } = await gitRun(dest, ['log', '--oneline', ...extraArgs]);
    return stdout.trim();
  });

  for (const r of results) {
    console.log(`\n=== [${r.repo.name}] ===`);
    if (!r.ok) {
      console.error(`ERROR: ${r.error.message}`);
    } else if (r.value) {
      console.log(r.value);
    } else {
      console.log('(no commits)');
    }
  }
}
