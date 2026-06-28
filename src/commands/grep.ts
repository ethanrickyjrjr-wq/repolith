import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export async function grepCommand(
  pattern: string,
  extraArgs: string[],
  manifestPath: string,
  json = false,
): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    // git grep requires options BEFORE the pattern; it exits 1 on no matches (not an error for us)
    const { stdout } = await gitRun(dest, ['grep', '--color=never', '-n', ...extraArgs, pattern])
      .catch(() => ({ stdout: '', stderr: '' }));
    return stdout;
  });

  const matches: { repo: string; hits: string[] }[] = [];
  for (const r of results) {
    if (r.ok && r.value.trim()) matches.push({ repo: r.repo.name, hits: r.value.trim().split('\n') });
  }

  if (json) {
    console.log(JSON.stringify(matches, null, 2));
  } else {
    for (const m of matches) {
      for (const line of m.hits) console.log(`[${m.repo}] ${line}`);
    }
  }

  if (matches.length === 0) process.exit(1);
}
