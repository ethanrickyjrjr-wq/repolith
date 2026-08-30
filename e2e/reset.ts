#!/usr/bin/env bun
// e2e/reset.ts — Wipe coordination state and restore workspace source files.
//
// Usage: bun run e2e/reset.ts [workspace-path]
// Default workspace: <repo>/../repolith-e2e
//
// Keeps: .git/, .claude/ (hooks stay installed)
// Clears: .repolith/ (plans/claims/waits/journal), any source edits (git reset)

import { rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const wsArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const WORKSPACE = wsArg ? resolve(wsArg) : resolve(import.meta.dir, '..', '..', 'repolith-e2e');

function run(args: string[], cwd = WORKSPACE): void {
  const r = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  if (out) console.log(`  ${out}`);
  if (!r.success) {
    const err = new TextDecoder().decode(r.stderr).trim();
    if (err) console.error(`  ${err}`);
    console.error(`✗ ${args.join(' ')}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  try {
    await access(WORKSPACE);
  } catch {
    console.error(`Workspace not found: ${WORKSPACE}`);
    console.error('Run bun run e2e/setup.ts first.');
    process.exit(1);
  }

  console.log(`\nResetting: ${WORKSPACE}\n`);

  // Wipe coordination state
  const repolith = join(WORKSPACE, '.repolith');
  await rm(repolith, { recursive: true, force: true });
  console.log('✓ .repolith/ cleared (plans, claims, waits, journal)');

  // Restore source files to the tagged baseline (not HEAD, which has agent commits).
  run(['git', 'reset', '--hard', 'initial']);
  run(['git', 'clean', '-fd']);
  console.log('✓ git reset --hard initial (source files restored)');

  console.log('\nReady for another run.');
}

main().catch((e) => { console.error(e); process.exit(1); });
