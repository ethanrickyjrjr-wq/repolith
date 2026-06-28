import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { readLockfile, computeHash } from '../lockfile.js';
import { gitClone, gitFetch, gitCheckoutCommit, gitRun } from '../git.js';
import { runAll } from '../runner.js';
import type { LockRepo } from '../types.js';

export interface RestoreResult {
  workspace: string;
  hash: string;
  repos: Record<string, LockRepo>;
  errors: { repo: string; message: string }[];
}

// Pure restore: clone-if-missing, fetch, detach each repo to its locked commit,
// then verify the recomputed atomic hash. Returns structured data — never prints
// or exits, so it is safe to call from the CLI *and* from the (stdio) MCP server.
export async function restoreToLock(manifestPath: string): Promise<RestoreResult> {
  const manifestDir = resolve(manifestPath, '..');
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const lock = await readLockfile(manifestDir);
  if (!lock) throw new Error('no repolith.lock.json — run `repolith sync` first');

  const results = await runAll(manifest.repos, async (repo) => {
    const locked = lock.repos[repo.name];
    if (!locked) throw new Error(`repo "${repo.name}" is not in the lockfile`);
    const dest = join(manifestDir, repo.path);
    if (!existsSync(dest)) await gitClone(repo.url, dest, repo.ref);
    await gitFetch(dest);
    await gitCheckoutCommit(dest, locked.commit);
    const head = (await gitRun(dest, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== locked.commit) {
      throw new Error(`HEAD ${head.slice(0, 8)} != locked ${locked.commit.slice(0, 8)}`);
    }
    return head;
  });

  const repos: Record<string, LockRepo> = {};
  const errors: { repo: string; message: string }[] = [];
  for (const r of results) {
    if (!r.ok) errors.push({ repo: r.repo.name, message: r.error.message });
    else repos[r.repo.name] = { url: r.repo.url, ref: r.repo.ref, commit: r.value };
  }

  const hash = computeHash(repos);
  if (errors.length === 0 && hash !== lock.hash) {
    throw new Error(
      `restored hash ${hash.slice(0, 12)} != lockfile hash ${lock.hash.slice(0, 12)} — refusing to claim reproducibility`,
    );
  }
  return { workspace: manifest.name, hash, repos, errors };
}

export async function checkoutCommand(manifestPath: string): Promise<void> {
  console.log('Restoring workspace to locked state…');
  const { workspace, hash, errors } = await restoreToLock(manifestPath);
  for (const e of errors) console.error(`  ERROR ${e.repo}: ${e.message}`);
  if (errors.length) {
    console.error('\nRestore completed with errors.');
    process.exit(1);
  }
  console.log(`"${workspace}" restored to ${hash.slice(0, 12)}… (detached at locked commits)`);
}
