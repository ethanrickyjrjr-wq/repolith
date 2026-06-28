import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { readLockfile, computeHash } from '../lockfile.js';
import { gitClone, gitFetch, gitCheckoutCommit, gitRun } from '../git.js';
import { runAll } from '../runner.js';
import type { Lockfile, LockRepo } from '../types.js';

export interface RestoreResult {
  workspace: string;
  hash: string;
  repos: Record<string, LockRepo>;
  errors: { repo: string; message: string }[];
}

// Pure restore to an arbitrary pinned state: clone-if-missing, fetch, detach each
// repo to its commit, then verify the recomputed atomic hash matches the state's.
// Returns structured data — never prints or exits, so it is safe to call from the
// CLI *and* from the (stdio) MCP server. Shared by `checkout` and `open`.
export async function restoreState(manifestPath: string, state: Lockfile): Promise<RestoreResult> {
  const manifestDir = resolve(manifestPath, '..');
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));

  const results = await runAll(manifest.repos, async (repo) => {
    const pinned = state.repos[repo.name];
    if (!pinned) throw new Error(`state has no commit for "${repo.name}"`);
    const dest = join(manifestDir, repo.path);
    if (!existsSync(dest)) await gitClone(repo.url, dest, repo.ref);
    await gitFetch(dest);
    await gitCheckoutCommit(dest, pinned.commit);
    const head = (await gitRun(dest, ['rev-parse', 'HEAD'])).stdout.trim();
    if (head !== pinned.commit) {
      throw new Error(`HEAD ${head.slice(0, 8)} != pinned ${pinned.commit.slice(0, 8)}`);
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
  if (errors.length === 0 && hash !== state.hash) {
    throw new Error(
      `restored hash ${hash.slice(0, 12)} != expected ${state.hash.slice(0, 12)} — refusing to claim reproducibility`,
    );
  }
  return { workspace: manifest.name, hash, repos, errors };
}

// Restore to the repo's own repolith.lock.json.
export async function restoreToLock(manifestPath: string): Promise<RestoreResult> {
  const lock = await readLockfile(resolve(manifestPath, '..'));
  if (!lock) throw new Error('no repolith.lock.json — run `repolith sync` first');
  return restoreState(manifestPath, lock);
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
