import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitClone, gitFetch, gitCheckout, gitCurrentCommit } from '../git.js';
import { computeHash, writeLockfile } from '../lockfile.js';
import { runAll } from '../runner.js';
import type { RepoEntry, LockRepo } from '../types.js';

export async function syncCommand(manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  console.log(`Syncing workspace "${manifest.name}" — ${manifest.repos.length} repos`);

  const results = await runAll(manifest.repos, async (repo: RepoEntry) => {
    const dest = join(manifestDir, repo.path);
    if (!existsSync(dest)) {
      process.stdout.write(`  [clone] ${repo.name}\n`);
      await gitClone(repo.url, dest, repo.ref);
    } else {
      process.stdout.write(`  [fetch] ${repo.name}\n`);
      await gitFetch(dest);
      await gitCheckout(dest, repo.ref);
    }
    return gitCurrentCommit(dest);
  });

  const lockRepos: Record<string, LockRepo> = {};
  let anyError = false;
  for (const r of results) {
    if (!r.ok) {
      console.error(`  ERROR ${r.repo.name}: ${r.error.message}`);
      anyError = true;
    } else {
      lockRepos[r.repo.name] = { url: r.repo.url, ref: r.repo.ref, commit: r.value };
    }
  }

  if (!anyError) {
    const hash = computeHash(lockRepos);
    await writeLockfile(manifestDir, { version: 1, repos: lockRepos, hash });
    console.log(`\nLockfile written. Workspace hash: ${hash.slice(0, 12)}…`);
  } else {
    console.error('\nSync completed with errors — lockfile NOT updated.');
    process.exit(1);
  }
}
