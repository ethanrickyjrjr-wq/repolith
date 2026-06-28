import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export async function diffCommand(extraArgs: string[], manifestPath: string, json = false): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    const { stdout } = await gitRun(dest, ['diff', ...extraArgs]);
    return stdout;
  });

  const anyDiff = results.some((r) => r.ok && r.value.trim().length > 0);

  if (json) {
    const data = results.map((r) =>
      r.ok ? { repo: r.repo.name, diff: r.value } : { repo: r.repo.name, error: r.error.message },
    );
    console.log(JSON.stringify(data, null, 2));
  } else {
    for (const r of results) {
      if (!r.ok) {
        console.error(`=== [${r.repo.name}] ERROR: ${r.error.message}`);
        continue;
      }
      if (r.value.trim()) {
        console.log(`\n=== [${r.repo.name}] ===`);
        process.stdout.write(r.value);
      }
    }
  }

  if (anyDiff) process.exit(1);
}
