import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { computeHash } from '../lockfile.js';
import { gitCurrentCommit } from '../git.js';
import { runAll } from '../runner.js';
import type { Lockfile, LockRepo } from '../types.js';

// Capture the current HEAD of every repo as a portable, hash-verified state object.
export async function buildState(manifestPath: string): Promise<Lockfile> {
  const manifestDir = resolve(manifestPath, '..');
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const results = await runAll(manifest.repos, (repo) => gitCurrentCommit(join(manifestDir, repo.path)));
  const repos: Record<string, LockRepo> = {};
  for (const r of results) {
    if (!r.ok) throw new Error(`${r.repo.name}: ${r.error.message}`);
    repos[r.repo.name] = { url: r.repo.url, ref: r.repo.ref, commit: r.value };
  }
  return { version: 1, repos, hash: computeHash(repos) };
}

// `repolith freeze [outfile]` — write a shareable snapshot of the current state.
export async function freezeCommand(manifestPath: string, outPath: string): Promise<void> {
  const state = await buildState(manifestPath);
  await writeFile(outPath, JSON.stringify(state, null, 2) + '\n', 'utf8');
  console.log(`Froze ${Object.keys(state.repos).length} repos → ${outPath}`);
  console.log(`Workspace hash: ${state.hash}`);
}

// `repolith state [--json]` — print the current atomic hash + per-repo commits.
export async function stateCommand(manifestPath: string, json = false): Promise<void> {
  const state = await buildState(manifestPath);
  if (json) {
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  console.log(`hash: ${state.hash}`);
  for (const [name, r] of Object.entries(state.repos)) {
    console.log(`  ${name}  ${r.commit.slice(0, 12)}  (${r.ref})`);
  }
}
