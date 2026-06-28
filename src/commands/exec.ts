import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execa } from 'execa';
import { parseManifest } from '../manifest.js';
import { runAll } from '../runner.js';

export async function execCommand(command: string, manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    const r = await execa(command, { cwd: dest, shell: true, reject: false });
    return { exitCode: r.exitCode ?? 0, stdout: r.stdout, stderr: r.stderr };
  });

  let anyFailure = false;
  for (const r of results) {
    console.log(`\n=== [${r.repo.name}] ===`);
    if (!r.ok) {
      console.error(`ERROR: ${r.error.message}`);
      anyFailure = true;
      continue;
    }
    if (r.value.stdout) process.stdout.write(r.value.stdout + '\n');
    if (r.value.stderr) process.stderr.write(r.value.stderr + '\n');
    if (r.value.exitCode !== 0) {
      console.error(`(exit ${r.value.exitCode})`);
      anyFailure = true;
    }
  }

  if (anyFailure) process.exit(1);
}
