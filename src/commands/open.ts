import { readFile } from 'node:fs/promises';
import { restoreState } from './checkout.js';
import type { Lockfile } from '../types.js';

// `repolith open <statefile>` — reconstruct the exact system from a shared state file
// (produced by `repolith freeze`). Paths come from the local repolith.toml; commits
// and the integrity hash come from the state file.
export async function openCommand(manifestPath: string, stateFilePath: string): Promise<void> {
  const state = JSON.parse(await readFile(stateFilePath, 'utf8')) as Lockfile;
  console.log(`Opening shared state from ${stateFilePath}…`);
  const { workspace, hash, errors } = await restoreState(manifestPath, state);
  for (const e of errors) console.error(`  ERROR ${e.repo}: ${e.message}`);
  if (errors.length) {
    console.error('\nOpen completed with errors.');
    process.exit(1);
  }
  console.log(`"${workspace}" restored to ${hash.slice(0, 12)}… from shared state`);
}
