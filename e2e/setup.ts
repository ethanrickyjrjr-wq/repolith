#!/usr/bin/env bun
// e2e/setup.ts — Create the §4 coord e2e test workspace and install hooks.
//
// Usage: bun run e2e/setup.ts [workspace-path] [--force]
// Default workspace: <repo>/../repolith-e2e
//
// --force wipes and recreates an existing workspace.
// Re-running without --force on a clean workspace is an error (not idempotent).

import { mkdir, writeFile, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const HERE = import.meta.dir;
const REPO_ROOT = resolve(HERE, '..');
const CLI = resolve(REPO_ROOT, 'src', 'cli.ts').replace(/\\/g, '/');

const force = process.argv.includes('--force');
const wsArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const WORKSPACE = wsArg ? resolve(wsArg) : resolve(REPO_ROOT, '..', 'repolith-e2e');

// ---------------------------------------------------------------------------
// Subprocess helpers
// ---------------------------------------------------------------------------

function run(args: string[], cwd = WORKSPACE): void {
  const r = Bun.spawnSync(args, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const out = new TextDecoder().decode(r.stdout).trim();
  const err = new TextDecoder().decode(r.stderr).trim();
  if (out) console.log(`  ${out.replace(/\n/g, '\n  ')}`);
  if (!r.success) {
    if (err) console.error(`  ${err.replace(/\n/g, '\n  ')}`);
    console.error(`\n✗ Command failed: ${args.join(' ')}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Workspace source files (the "codebase" agents will work on)
// ---------------------------------------------------------------------------

const SOURCE: Record<string, string> = {
  'src/types.ts': `// Shared types for mylib

export interface User {
  id: string;
  email: string;
  createdAt: string;
}
`,
  'src/auth.ts': `// Authentication utilities

export async function logout(_token: string): Promise<void> {
  // stub: clear the session
}
`,
  'src/api.ts': `// API client

export const BASE_URL = 'https://api.mylib.dev/v1';

export async function ping(): Promise<boolean> {
  return true; // stub
}
`,
  'src/index.ts': `export * from './auth.js';
export * from './api.js';
export * from './types.js';
`,
  'README.md': `# mylib

A TypeScript utility library.

## Modules

- **auth** — authentication utilities (logout)
- **api** — API client utilities (ping)
`,
  'repolith.toml': `[workspace]
name = "coord-e2e"

[[repos]]
name = "mylib"
url = "local"
path = "."
ref = "main"
`,
  '.gitignore': `node_modules/
dist/
.repolith/
`,
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let exists = false;
  try {
    await access(WORKSPACE);
    exists = true;
  } catch { /* not found */ }

  if (exists && !force) {
    console.error(`Workspace already exists: ${WORKSPACE}`);
    console.error('Run with --force to wipe and recreate it.');
    process.exit(1);
  }
  if (exists && force) {
    console.log(`Wiping ${WORKSPACE}...`);
    await rm(WORKSPACE, { recursive: true, force: true });
  }

  console.log(`\nCreating workspace: ${WORKSPACE}\n`);
  await mkdir(join(WORKSPACE, 'src'), { recursive: true });

  for (const [rel, content] of Object.entries(SOURCE)) {
    await writeFile(join(WORKSPACE, rel), content, 'utf8');
  }
  console.log('✓ source files written');

  run(['git', 'init']);
  run(['git', 'config', 'user.name', 'coord-e2e']);
  run(['git', 'config', 'user.email', 'e2e@repolith.local']);
  run(['git', 'add', '-A']);
  run(['git', 'commit', '-m', 'initial: coord e2e workspace']);
  console.log('✓ git init + initial commit');

  // Install hooks by spawning the CLI so selfInvocation() sees src/cli.ts in argv[1]
  // and writes `bun run <absolute-CLI-path> edit-hook` into .claude/settings.json.
  console.log('\nInstalling hooks...');
  run(
    ['bun', 'run', CLI, 'hooks', 'install', '--post-commit',
     '--manifest', join(WORKSPACE, 'repolith.toml').replace(/\\/g, '/')],
    REPO_ROOT,
  );
  console.log('✓ hooks installed');

  // Commit .claude/settings.json so `git reset --hard initial` in reset.ts can restore it.
  // Without this, `git clean -fd` would wipe the hooks after each reset.
  run(['git', 'add', '-f', '.claude']);
  run(['git', 'commit', '-m', 'chore: install coordination hooks']);

  // Tag this as the reset baseline so reset.ts can always return here,
  // regardless of how many agent commits pile up during test runs.
  run(['git', 'tag', 'initial']);
  console.log('✓ hooks committed + tagged as "initial"\n');

  const ws = WORKSPACE.replace(/\\/g, '/');
  console.log(`Ready. Here's how to run the test:

  Terminal 1 (Agent A):
    cd "${ws}"
    claude
    → paste the contents of e2e/prompts/agent-a.md

  Terminal 2 (Agent B — start ~30s after A exits plan mode):
    cd "${ws}"
    claude
    → paste the contents of e2e/prompts/agent-b.md

  Terminal 3 (optional Agent C):
    cd "${ws}"
    claude
    → paste the contents of e2e/prompts/agent-c.md

  Observation terminal:
    bun run e2e/observe.ts

  Reset and re-run:
    bun run e2e/reset.ts

See e2e/README.md for what to watch.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
