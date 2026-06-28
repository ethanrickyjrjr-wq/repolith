import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { readLockfile, computeHash } from '../lockfile.js';
import { gitClone, gitFetch, gitCheckoutCommit, gitRun } from '../git.js';
import { runAll } from '../runner.js';
import type { LockRepo } from '../types.js';

export async function checkoutCommand(manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const lock = await readLockfile(manifestDir);
  if (!lock) throw new Error('no repolith.lock.json — run `repolith sync` first');

  console.log(`Restoring workspace "${manifest.name}" to locked state — ${manifest.repos.length} repos`);

  const results = await runAll(manifest.repos, async (repo) => {
    const locked = lock.repos[repo.name];
    if (!locked) throw new Error(`repo "${repo.name}" is not in the lockfile`);
    const dest = join(manifestDir, repo.path);
    if (!existsSync(dest)) {
      process.stdout.write(`  [clone] ${repo.name}\n`);
      await gitClone(repo.url, dest, repo.ref);
    }
    await gitFetch(dest);
    await gitCheckoutCommit(dest, locked.commit);
    const { stdout } = await gitRun(dest, ['rev-parse', 'HEAD']);
    const head = stdout.trim();
    if (head !== locked.commit) {
      throw new Error(`${repo.name}: HEAD ${head.slice(0, 8)} != locked ${locked.commit.slice(0, 8)}`);
    }
    return head;
  });

  const restored: Record<string, LockRepo> = {};
  let anyError = false;
  for (const r of results) {
    if (!r.ok) {
      console.error(`  ERROR ${r.repo.name}: ${r.error.message}`);
      anyError = true;
    } else {
      restored[r.repo.name] = { url: r.repo.url, ref: r.repo.ref, commit: r.value };
    }
  }
  if (anyError) process.exit(1);

  const hash = computeHash(restored);
  if (hash !== lock.hash) {
    throw new Error(
      `restored hash ${hash.slice(0, 12)} != lockfile hash ${lock.hash.slice(0, 12)} — refusing to claim reproducibility`,
    );
  }
  console.log(`\nWorkspace restored to ${hash.slice(0, 12)}… (detached at locked commits)`);
}
