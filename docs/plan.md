# repolith — Workspace VCS Composition Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Recommended model:** 🧠 Opus — 15 tasks, 27 files, 2 conflict groups, keywords: architecture

**Goal:** Build `repolith` — a CLI + VS Code extension that makes a set of independent git repos feel like one monorepo without touching git internals, GitHub, or CI.

**Architecture:** A `repolith.toml` manifest declares which repos belong together and where they live locally. A JSON lockfile records each repo's pinned commit hash and an atomic workspace hash. A CLI wrapper (`repolith sync`, `repolith status`, `repolith grep`, `repolith log`, `repolith diff`, `repolith exec`, `repolith init`) dispatches git commands in parallel across all repos and merges the output. A VS Code extension adds all repo folders to the workspace and provides cross-repo search.

**Tech Stack:** TypeScript + Bun, `commander` (CLI parsing), `smol-toml` (TOML parsing), `execa` (spawn git), `p-limit` (concurrency cap), Bun test runner (tests), VS Code Extension API.

## Global Constraints

- Bun ≥1.1 as runtime and test runner for the CLI; `vitest` is acceptable alternative if Bun test runner lacks a feature needed
- Node.js ≥20 for the VS Code extension (VS Code ships its own Node)
- No kernel drivers, no new object model, no patch theory — git is untouched
- All git operations shell out to the system `git` binary via `execa`
- Concurrency cap: 8 parallel git processes (configurable via `REPOLITH_CONCURRENCY`)
- The project lives at a path of the implementer's choosing — it is NOT inside `brain-platform`
- Lockfile is always named `repolith.lock.json` and lives next to `repolith.toml`
- Workspace hash = `sha256` of newline-joined sorted `"name:commit"` pairs, hex-encoded

---

## File Structure

```
repolith/
├── src/
│   ├── types.ts              # WorkspaceManifest, RepoEntry, Lockfile, LockRepo types
│   ├── manifest.ts           # parse repolith.toml → WorkspaceManifest
│   ├── lockfile.ts           # read/write repolith.lock.json, compute hash
│   ├── git.ts                # thin wrappers: clone, fetch, checkout, currentCommit, run
│   ├── runner.ts             # parallel dispatch: runAll(repos, fn) → RepoResult[]
│   ├── commands/
│   │   ├── sync.ts           # repolith sync — clone missing, fetch + checkout all
│   │   ├── status.ts         # repolith status — branch + dirty/clean + ahead/behind table
│   │   ├── exec.ts           # repolith exec — run a command in every repo
│   │   ├── grep.ts           # repolith grep <pattern> [options]
│   │   ├── log.ts            # repolith log [options]
│   │   ├── diff.ts           # repolith diff [options]
│   │   └── init.ts           # repolith init — interactive repolith.toml creator
│   └── cli.ts                # entry point — commander setup, command routing
├── tests/
│   ├── manifest.test.ts
│   ├── lockfile.test.ts
│   ├── git.test.ts           # uses real git + temp dirs
│   └── runner.test.ts
├── vscode-extension/
│   ├── src/
│   │   ├── extension.ts      # activate/deactivate
│   │   ├── workspace.ts      # WorkspaceFolderProvider — adds repos as VS Code folders
│   │   └── search.ts         # cross-repo text search via grep command
│   └── package.json
├── package.json
├── tsconfig.json
└── README.md
```

---

### Task 1: Project Scaffold

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `src/types.ts`
- 🔴 Create: `src/cli.ts` (stub)

**Interfaces:**
- Produces: `WorkspaceManifest`, `RepoEntry`, `Lockfile`, `LockRepo` types consumed by all later tasks

- [ ] **Step 1: Init the project**

```bash
mkdir repolith && cd repolith
bun init -y
bun add commander smol-toml execa p-limit
bun add -d @types/node typescript
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "vscode-extension"]
}
```

- [ ] **Step 3: Write `src/types.ts`**

```typescript
export interface RepoEntry {
  name: string;
  url: string;
  path: string;    // relative path from workspace root where repo is cloned
  ref: string;     // branch/tag/sha to track
}

export interface WorkspaceManifest {
  name: string;
  repos: RepoEntry[];
}

export interface LockRepo {
  url: string;
  ref: string;
  commit: string;  // full SHA
}

export interface Lockfile {
  version: 1;
  repos: Record<string, LockRepo>;  // keyed by repo name
  hash: string;                     // sha256 hex of sorted "name:commit" lines
}
```

- [ ] **Step 4: Write stub `src/cli.ts`**

```typescript
import { Command } from 'commander';

const program = new Command();
program
  .name('repolith')
  .description('Multi-repo workspace tool')
  .version('0.1.0');

program.parse();
```

- [ ] **Step 5: Add scripts to `package.json`**

```json
{
  "scripts": {
    "build": "bun build src/cli.ts --outfile dist/cli.js --target node",
    "test": "bun test",
    "dev": "bun run src/cli.ts"
  },
  "bin": {
    "repolith": "dist/cli.js"
  }
}
```

- [ ] **Step 6: Verify it runs**

```bash
bun run dev --help
```

Expected output: prints `repolith` usage with version `0.1.0`, exits 0.

- [ ] **Step 7: Commit**

```bash
git init && git add package.json tsconfig.json src/types.ts src/cli.ts
git commit -m "feat: scaffold repolith project"
```

---

### Task 2: Manifest Parser

**Files:**
- Create: `src/manifest.ts`
- Create: `tests/manifest.test.ts`

**Interfaces:**
- Consumes: `WorkspaceManifest`, `RepoEntry` from `src/types.ts`
- Produces: `parseManifest(tomlString: string): WorkspaceManifest` — throws `Error` with descriptive message on invalid input

- [ ] **Step 1: Write failing tests**

```typescript
// tests/manifest.test.ts
import { describe, it, expect } from 'bun:test';
import { parseManifest } from '../src/manifest';

const VALID = `
[workspace]
name = "my-workspace"

[[repos]]
name = "frontend"
url = "https://github.com/org/frontend.git"
path = "packages/frontend"
ref = "main"

[[repos]]
name = "backend"
url = "https://github.com/org/backend.git"
path = "packages/backend"
ref = "main"
`;

describe('parseManifest', () => {
  it('parses a valid manifest', () => {
    const m = parseManifest(VALID);
    expect(m.name).toBe('my-workspace');
    expect(m.repos).toHaveLength(2);
    expect(m.repos[0]).toEqual({
      name: 'frontend',
      url: 'https://github.com/org/frontend.git',
      path: 'packages/frontend',
      ref: 'main',
    });
  });

  it('throws when workspace.name is missing', () => {
    expect(() => parseManifest(`[[repos]]\nname="a"\nurl="u"\npath="p"\nref="r"`))
      .toThrow('workspace.name');
  });

  it('throws when a repo is missing required fields', () => {
    expect(() => parseManifest(`[workspace]\nname="ws"\n[[repos]]\nname="a"`))
      .toThrow('repos[0]');
  });

  it('throws on duplicate repo names', () => {
    const dup = `[workspace]\nname="ws"\n[[repos]]\nname="a"\nurl="u"\npath="p"\nref="r"\n[[repos]]\nname="a"\nurl="u2"\npath="p2"\nref="r"`;
    expect(() => parseManifest(dup)).toThrow('duplicate');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/manifest.test.ts
```

Expected: 4 failures — `parseManifest` not found.

- [ ] **Step 3: Implement `src/manifest.ts`**

```typescript
import { parse } from 'smol-toml';
import type { WorkspaceManifest, RepoEntry } from './types.js';

export function parseManifest(tomlString: string): WorkspaceManifest {
  const raw = parse(tomlString) as Record<string, unknown>;

  const ws = raw['workspace'] as Record<string, unknown> | undefined;
  if (!ws || typeof ws['name'] !== 'string') {
    throw new Error('workspace.name is required and must be a string');
  }

  const rawRepos = raw['repos'];
  if (!Array.isArray(rawRepos)) {
    throw new Error('At least one [[repos]] entry is required');
  }

  const names = new Set<string>();
  const repos: RepoEntry[] = rawRepos.map((r: unknown, i: number) => {
    const repo = r as Record<string, unknown>;
    for (const field of ['name', 'url', 'path', 'ref']) {
      if (typeof repo[field] !== 'string') {
        throw new Error(`repos[${i}].${field} is required and must be a string`);
      }
    }
    const name = repo['name'] as string;
    if (names.has(name)) {
      throw new Error(`duplicate repo name: "${name}"`);
    }
    names.add(name);
    return {
      name,
      url: repo['url'] as string,
      path: repo['path'] as string,
      ref: repo['ref'] as string,
    };
  });

  return { name: ws['name'] as string, repos };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/manifest.test.ts
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add src/manifest.ts tests/manifest.test.ts
git commit -m "feat: manifest parser with validation"
```

---

### Task 3: Lockfile + Hash

**Files:**
- Create: `src/lockfile.ts`
- Create: `tests/lockfile.test.ts`

**Interfaces:**
- Consumes: `Lockfile`, `LockRepo` from `src/types.ts`
- Produces:
  - `computeHash(repos: Record<string, LockRepo>): string` — sha256 hex
  - `readLockfile(dir: string): Promise<Lockfile | null>` — null if file absent
  - `writeLockfile(dir: string, lock: Lockfile): Promise<void>`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/lockfile.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeHash, readLockfile, writeLockfile } from '../src/lockfile';
import type { LockRepo } from '../src/types';

const REPOS: Record<string, LockRepo> = {
  frontend: { url: 'https://github.com/org/frontend.git', ref: 'main', commit: 'abc123' },
  backend:  { url: 'https://github.com/org/backend.git',  ref: 'main', commit: 'def456' },
};

describe('computeHash', () => {
  it('produces a 64-char hex string', () => {
    const h = computeHash(REPOS);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic regardless of insertion order', () => {
    const reversed: Record<string, LockRepo> = { backend: REPOS.backend, frontend: REPOS.frontend };
    expect(computeHash(REPOS)).toBe(computeHash(reversed));
  });

  it('changes when a commit changes', () => {
    const modified = { ...REPOS, frontend: { ...REPOS.frontend, commit: 'zzz' } };
    expect(computeHash(REPOS)).not.toBe(computeHash(modified));
  });
});

describe('readLockfile / writeLockfile', () => {
  let dir: string;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ws-lock-')); });
  afterEach(async () => { await rm(dir, { recursive: true }); });

  it('returns null when lockfile is absent', async () => {
    expect(await readLockfile(dir)).toBeNull();
  });

  it('round-trips through write + read', async () => {
    const hash = computeHash(REPOS);
    const lock = { version: 1 as const, repos: REPOS, hash };
    await writeLockfile(dir, lock);
    const read = await readLockfile(dir);
    expect(read).toEqual(lock);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/lockfile.test.ts
```

Expected: failures — module not found.

- [ ] **Step 3: Implement `src/lockfile.ts`**

```typescript
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lockfile, LockRepo } from './types.js';

const LOCK_FILENAME = 'repolith.lock.json';

export function computeHash(repos: Record<string, LockRepo>): string {
  const lines = Object.entries(repos)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, r]) => `${name}:${r.commit}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

export async function readLockfile(dir: string): Promise<Lockfile | null> {
  try {
    const text = await readFile(join(dir, LOCK_FILENAME), 'utf8');
    return JSON.parse(text) as Lockfile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeLockfile(dir: string, lock: Lockfile): Promise<void> {
  await writeFile(join(dir, LOCK_FILENAME), JSON.stringify(lock, null, 2) + '\n', 'utf8');
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/lockfile.test.ts
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/lockfile.ts tests/lockfile.test.ts
git commit -m "feat: lockfile read/write + deterministic hash"
```

---

### Task 4: Git Wrapper

**Files:**
- Create: `src/git.ts`
- Create: `tests/git.test.ts`

**Interfaces:**
- Consumes: `execa` from npm
- Produces:
  - `gitClone(url: string, dest: string, ref: string): Promise<void>`
  - `gitFetch(repoDir: string): Promise<void>`
  - `gitCheckout(repoDir: string, ref: string): Promise<void>`
  - `gitCurrentCommit(repoDir: string): Promise<string>` — returns full SHA
  - `gitRun(repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }>`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/git.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { gitClone, gitCurrentCommit, gitRun, gitFetch, gitCheckout } from '../src/git';

// Create a bare local repo to clone from (no network needed)
let remoteDir: string;
let workDir: string;

beforeAll(async () => {
  remoteDir = await mkdtemp(join(tmpdir(), 'ws-remote-'));
  workDir   = await mkdtemp(join(tmpdir(), 'ws-work-'));
  // init bare repo
  await execa('git', ['init', '--bare', remoteDir]);
  // create a commit in a temp clone
  const tmp = await mkdtemp(join(tmpdir(), 'ws-tmp-'));
  await execa('git', ['clone', remoteDir, tmp]);
  await execa('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: tmp });
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: tmp });
  await rm(tmp, { recursive: true });
});

afterAll(async () => {
  await rm(remoteDir, { recursive: true });
  await rm(workDir,   { recursive: true });
});

describe('gitClone + gitCurrentCommit', () => {
  it('clones a repo and returns a 40-char SHA', async () => {
    const dest = join(workDir, 'cloned');
    await gitClone(remoteDir, dest, 'main');
    const sha = await gitCurrentCommit(dest);
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe('gitRun', () => {
  it('runs an arbitrary git command in the repo dir', async () => {
    const dest = join(workDir, 'cloned');
    const { stdout } = await gitRun(dest, ['log', '--oneline', '-1']);
    expect(stdout.trim()).toMatch(/init/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/git.test.ts
```

Expected: failures — module not found.

- [ ] **Step 3: Implement `src/git.ts`**

```typescript
import { execa } from 'execa';

async function git(cwd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await execa('git', args, { cwd, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}:\n${result.stderr}`);
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

export async function gitClone(url: string, dest: string, ref: string): Promise<void> {
  await execa('git', ['clone', '--branch', ref, '--single-branch', url, dest], { reject: false })
    .then(r => {
      if (r.exitCode !== 0) throw new Error(`git clone failed:\n${r.stderr}`);
    });
}

export async function gitFetch(repoDir: string): Promise<void> {
  await git(repoDir, ['fetch', '--all', '--prune']);
}

export async function gitCheckout(repoDir: string, ref: string): Promise<void> {
  await git(repoDir, ['checkout', ref]);
  await git(repoDir, ['pull', '--ff-only']);
}

export async function gitCurrentCommit(repoDir: string): Promise<string> {
  const { stdout } = await git(repoDir, ['rev-parse', 'HEAD']);
  return stdout.trim();
}

export async function gitRun(repoDir: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return git(repoDir, args);
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/git.test.ts
```

Expected: passing.

- [ ] **Step 5: Commit**

```bash
git add src/git.ts tests/git.test.ts
git commit -m "feat: git wrapper — clone/fetch/checkout/currentCommit/run"
```

---

### Task 5: Parallel Runner

**Files:**
- Create: `src/runner.ts`
- Create: `tests/runner.test.ts`

**Interfaces:**
- Consumes: `RepoEntry` from `src/types.ts`, `p-limit` from npm
- Produces:
  ```typescript
  interface RepoResult<T> {
    repo: RepoEntry;
    ok: true;
    value: T;
  } | {
    repo: RepoEntry;
    ok: false;
    error: Error;
  }

  function runAll<T>(
    repos: RepoEntry[],
    fn: (repo: RepoEntry) => Promise<T>,
    concurrency?: number
  ): Promise<RepoResult<T>[]>
  ```

- [ ] **Step 1: Write failing tests**

```typescript
// tests/runner.test.ts
import { describe, it, expect } from 'bun:test';
import { runAll } from '../src/runner';
import type { RepoEntry } from '../src/types';

const REPOS: RepoEntry[] = [
  { name: 'a', url: 'u', path: 'p', ref: 'main' },
  { name: 'b', url: 'u', path: 'p', ref: 'main' },
  { name: 'c', url: 'u', path: 'p', ref: 'main' },
];

describe('runAll', () => {
  it('returns a result for every repo', async () => {
    const results = await runAll(REPOS, async (r) => r.name.toUpperCase());
    expect(results).toHaveLength(3);
  });

  it('captures success values', async () => {
    const results = await runAll(REPOS, async (r) => r.name + '!');
    for (const r of results) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value).toBe(r.repo.name + '!');
    }
  });

  it('captures errors without throwing', async () => {
    const results = await runAll(REPOS, async (r) => {
      if (r.name === 'b') throw new Error('boom');
      return r.name;
    });
    const b = results.find(r => r.repo.name === 'b')!;
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error.message).toBe('boom');
    // others still succeed
    expect(results.filter(r => r.ok)).toHaveLength(2);
  });

  it('respects concurrency cap', async () => {
    let active = 0;
    let maxActive = 0;
    const many = Array.from({ length: 10 }, (_, i) => ({
      name: String(i), url: '', path: '', ref: 'main',
    }));
    await runAll(many, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise(r => setTimeout(r, 5));
      active--;
    }, 3);
    expect(maxActive).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
bun test tests/runner.test.ts
```

Expected: failures.

- [ ] **Step 3: Implement `src/runner.ts`**

```typescript
import pLimit from 'p-limit';
import type { RepoEntry } from './types.js';

export type RepoResult<T> =
  | { repo: RepoEntry; ok: true; value: T }
  | { repo: RepoEntry; ok: false; error: Error };

export async function runAll<T>(
  repos: RepoEntry[],
  fn: (repo: RepoEntry) => Promise<T>,
  concurrency = Number(process.env['REPOLITH_CONCURRENCY'] ?? 8),
): Promise<RepoResult<T>[]> {
  const limit = pLimit(concurrency);
  return Promise.all(
    repos.map(repo =>
      limit(async () => {
        try {
          const value = await fn(repo);
          return { repo, ok: true as const, value };
        } catch (e: unknown) {
          return { repo, ok: false as const, error: e instanceof Error ? e : new Error(String(e)) };
        }
      }),
    ),
  );
}
```

- [ ] **Step 4: Run tests**

```bash
bun test tests/runner.test.ts
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts tests/runner.test.ts
git commit -m "feat: parallel runner with concurrency cap + error capture"
```

---

### Task 6: `repolith sync` Command

**Files:**
- Create: `src/commands/sync.ts`
- 🔴 Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `parseManifest`, `gitClone`, `gitFetch`, `gitCheckout`, `gitCurrentCommit`, `computeHash`, `writeLockfile`, `runAll`
- Produces: cloned/updated repos on disk + updated `repolith.lock.json`

- [ ] **Step 1: Write `src/commands/sync.ts`**

```typescript
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
```

- [ ] **Step 2: Wire into `src/cli.ts`**

```typescript
import { Command } from 'commander';
import { syncCommand } from './commands/sync.js';

const program = new Command();
program
  .name('repolith')
  .description('Multi-repo workspace tool')
  .version('0.1.0');

program
  .command('sync')
  .description('Clone missing repos and update all to their locked refs')
  .argument('[manifest]', 'Path to repolith.toml', 'repolith.toml')
  .action(async (manifest: string) => {
    await syncCommand(manifest).catch(e => {
      console.error(e.message);
      process.exit(1);
    });
  });

program.parse();
```

- [ ] **Step 3: Smoke-test manually**

Create a `repolith.toml` pointing at two real public repos (e.g., `torvalds/linux` is large — use something small like a personal repo or any two small public repos):

```toml
[workspace]
name = "test-ws"

[[repos]]
name = "hello"
url = "https://github.com/octocat/Hello-World.git"
path = "repos/hello"
ref = "master"
```

Run:
```bash
bun run dev sync repolith.toml
```

Expected: repo cloned to `repos/hello/`, `repolith.lock.json` written, hash printed.

Run again:
```bash
bun run dev sync repolith.toml
```

Expected: `[fetch] hello` (not clone), lockfile updated.

- [ ] **Step 4: Commit**

```bash
git add src/commands/sync.ts src/cli.ts
git commit -m "feat: repolith sync — clone/update repos, write lockfile"
```

---

### Task 7: `repolith status` Command

**Files:**
- Create: `src/commands/status.ts`
- 🔴 Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `parseManifest`, `gitRun`, `runAll`
- Produces: a color-coded table — one row per repo with branch, dirty/clean, and ahead/behind counts. This is the daily-driver command (gita's killer feature).

- [ ] **Step 1: Write `src/commands/status.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

const color = (code: number, s: string): string =>
  process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const green = (s: string) => color(32, s);
const red = (s: string) => color(31, s);

interface RepoStatus { branch: string; dirty: boolean; ahead: number; behind: number; }

async function repoStatus(dest: string): Promise<RepoStatus> {
  const { stdout: branch } = await gitRun(dest, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const { stdout: porcelain } = await gitRun(dest, ['status', '--porcelain']);
  let ahead = 0;
  let behind = 0;
  try {
    const { stdout } = await gitRun(dest, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
    const [b, a] = stdout.trim().split(/\s+/).map(Number);
    behind = b || 0;
    ahead = a || 0;
  } catch {
    // no upstream tracking branch configured — leave ahead/behind at 0
  }
  return { branch: branch.trim(), dirty: porcelain.trim().length > 0, ahead, behind };
}

export async function statusCommand(manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, (repo) =>
    repoStatus(join(manifestDir, repo.path)),
  );

  const nameWidth = Math.max(4, ...manifest.repos.map(r => r.name.length));
  for (const r of results) {
    const name = r.repo.name.padEnd(nameWidth);
    if (!r.ok) {
      console.log(`${name}  ${red('ERROR')}: ${r.error.message}`);
      continue;
    }
    const { branch, dirty, ahead, behind } = r.value;
    const state = dirty ? red('dirty') : green('clean');
    const track = [ahead ? `↑${ahead}` : '', behind ? `↓${behind}` : ''].filter(Boolean).join(' ');
    console.log(`${name}  ${branch.padEnd(20)}  ${state}  ${track}`.trimEnd());
  }
}
```

- [ ] **Step 2: Wire into `src/cli.ts`**

```typescript
import { statusCommand } from './commands/status.js';

program
  .command('status')
  .description('Show branch + dirty/clean + ahead/behind for every repo')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (opts: { manifest: string }) => {
    await statusCommand(opts.manifest).catch(e => {
      console.error(e.message);
      process.exit(1);
    });
  });
```

- [ ] **Step 3: Smoke-test**

After `repolith sync` has run:
```bash
bun run dev status --manifest repolith.toml
```

Expected: one row per repo, e.g. `hello   master   clean`. Make a scratch edit in a cloned repo and re-run — that repo flips to `dirty`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/status.ts src/cli.ts
git commit -m "feat: repolith status — color-coded branch/dirty/ahead-behind table"
```

---

### Task 8: `repolith exec` Command

**Files:**
- Create: `src/commands/exec.ts`
- 🔴 Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `parseManifest`, `runAll`, `execa` from npm
- Produces: runs an arbitrary shell command in each repo's directory; prints a `=== [repo-name] ===` header + that repo's stdout/stderr; exits 1 if any repo's command exits non-zero

- [ ] **Step 1: Write `src/commands/exec.ts`**

```typescript
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
```

- [ ] **Step 2: Wire into `src/cli.ts`**

```typescript
import { execCommand } from './commands/exec.js';

program
  .command('exec')
  .description('Run a shell command in every repo (quote the command)')
  .argument('<command>', 'Command to run, e.g. "npm test"')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (command: string, opts: { manifest: string }) => {
    await execCommand(command, opts.manifest).catch(e => {
      console.error(e.message);
      process.exit(1);
    });
  });
```

- [ ] **Step 3: Smoke-test**

```bash
bun run dev exec "git rev-parse --short HEAD" --manifest repolith.toml
```

Expected: a `=== [hello] ===` header followed by the repo's short HEAD SHA. Try `repolith exec "false"` → process exits 1.

- [ ] **Step 4: Commit**

```bash
git add src/commands/exec.ts src/cli.ts
git commit -m "feat: repolith exec — run an arbitrary command across all repos"
```

---

### Task 9: `repolith grep` Command

**Files:**
- Create: `src/commands/grep.ts`
- 🔴 Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `parseManifest`, `readLockfile`, `gitRun`, `runAll`
- Produces: stdout with `[repo-name] <git grep output>` lines, exit code 1 if no matches (mirrors git grep behavior)

- [ ] **Step 1: Write `src/commands/grep.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export async function grepCommand(pattern: string, extraArgs: string[], manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    // git grep exits 1 when no matches — that's not an error
    const { stdout } = await gitRun(dest, ['grep', '--color=never', '-n', pattern, ...extraArgs])
      .catch(() => ({ stdout: '', stderr: '' }));
    return stdout;
  });

  let anyMatch = false;
  for (const r of results) {
    if (!r.ok || !r.value.trim()) continue;
    const lines = r.value.trim().split('\n');
    for (const line of lines) {
      console.log(`[${r.repo.name}] ${line}`);
      anyMatch = true;
    }
  }

  if (!anyMatch) process.exit(1);
}
```

- [ ] **Step 2: Add to `src/cli.ts`**

Add after the sync command:

```typescript
import { grepCommand } from './commands/grep.js';

program
  .command('grep')
  .description('Search across all repos (uses git grep)')
  .argument('<pattern>', 'Search pattern')
  .option('-i, --ignore-case', 'Case-insensitive match')
  .option('-l, --files-with-matches', 'Print only filenames')
  .option('-w, --word-regexp', 'Match whole words only')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .allowUnknownOption()
  .action(async (pattern: string, opts: { ignoreCase?: boolean; filesWithMatches?: boolean; wordRegexp?: boolean; manifest: string }) => {
    const extra: string[] = [];
    if (opts.ignoreCase) extra.push('-i');
    if (opts.filesWithMatches) extra.push('-l');
    if (opts.wordRegexp) extra.push('-w');
    await grepCommand(pattern, extra, opts.manifest).catch(e => {
      console.error(e.message);
      process.exit(1);
    });
  });
```

- [ ] **Step 3: Smoke-test**

After `repolith sync` has run:
```bash
bun run dev grep "TODO" --manifest repolith.toml
```

Expected: lines prefixed with `[hello]` for any TODO strings in the Hello-World repo (or empty → exits 1).

- [ ] **Step 4: Commit**

```bash
git add src/commands/grep.ts src/cli.ts
git commit -m "feat: repolith grep — parallel git grep across all repos"
```

---

### Task 10: `repolith log` Command

**Files:**
- Create: `src/commands/log.ts`
- 🔴 Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `parseManifest`, `gitRun`, `runAll`
- Produces: stdout interleaved with `=== [repo-name] ===` headers separating each repo's log output

- [ ] **Step 1: Write `src/commands/log.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export async function logCommand(extraArgs: string[], manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    const { stdout } = await gitRun(dest, ['log', '--oneline', ...extraArgs]);
    return stdout.trim();
  });

  for (const r of results) {
    console.log(`\n=== [${r.repo.name}] ===`);
    if (!r.ok) {
      console.error(`ERROR: ${r.error.message}`);
    } else if (r.value) {
      console.log(r.value);
    } else {
      console.log('(no commits)');
    }
  }
}
```

- [ ] **Step 2: Add to `src/cli.ts`**

```typescript
import { logCommand } from './commands/log.js';

program
  .command('log')
  .description('Show git log for all repos')
  .option('-n, --max-count <n>', 'Limit number of commits', '10')
  .option('--since <date>', 'Show commits more recent than date')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (opts: { maxCount: string; since?: string; manifest: string }) => {
    const extra = ['-n', opts.maxCount];
    if (opts.since) extra.push(`--since=${opts.since}`);
    await logCommand(extra, opts.manifest).catch(e => {
      console.error(e.message);
      process.exit(1);
    });
  });
```

- [ ] **Step 3: Smoke-test**

```bash
bun run dev log -n 5 --manifest repolith.toml
```

Expected: `=== [hello] ===` header followed by ≤5 one-line commit summaries.

- [ ] **Step 4: Commit**

```bash
git add src/commands/log.ts src/cli.ts
git commit -m "feat: repolith log — git log across all repos with headers"
```

---

### Task 11: `repolith diff` Command

**Files:**
- Create: `src/commands/diff.ts`
- 🔴 Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `parseManifest`, `gitRun`, `runAll`
- Produces: stdout with `=== [repo-name] ===` headers + `git diff` output per repo; exits 1 if any repo has unstaged changes (mirrors git diff behavior)

- [ ] **Step 1: Write `src/commands/diff.ts`**

```typescript
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from '../manifest.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export async function diffCommand(extraArgs: string[], manifestPath: string): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const toml = await readFile(manifestPath, 'utf8');
  const manifest = parseManifest(toml);

  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(manifestDir, repo.path);
    const { stdout } = await gitRun(dest, ['diff', ...extraArgs]);
    return stdout;
  });

  let anyDiff = false;
  for (const r of results) {
    if (!r.ok) {
      console.error(`=== [${r.repo.name}] ERROR: ${r.error.message}`);
      continue;
    }
    if (r.value.trim()) {
      console.log(`\n=== [${r.repo.name}] ===`);
      process.stdout.write(r.value);
      anyDiff = true;
    }
  }

  if (anyDiff) process.exit(1);
}
```

- [ ] **Step 2: Add to `src/cli.ts`**

```typescript
import { diffCommand } from './commands/diff.js';

program
  .command('diff')
  .description('Show git diff across all repos')
  .option('--staged', 'Show staged changes')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .allowUnknownOption()
  .action(async (opts: { staged?: boolean; manifest: string }) => {
    const extra: string[] = [];
    if (opts.staged) extra.push('--staged');
    await diffCommand(extra, opts.manifest).catch(e => {
      console.error(e.message);
      process.exit(1);
    });
  });
```

- [ ] **Step 3: Smoke-test**

```bash
bun run dev diff --manifest repolith.toml
```

Expected: no output + exits 0 (clean repos). Make a scratch change in a cloned repo, re-run — diff section appears, exits 1.

- [ ] **Step 4: Commit**

```bash
git add src/commands/diff.ts src/cli.ts
git commit -m "feat: repolith diff — git diff across all repos"
```

---

### Task 12: `repolith init` Command

**Files:**
- Create: `src/commands/init.ts`
- 🔴 Modify: `src/cli.ts`

**Interfaces:**
- Consumes: `node:readline/promises` (no new dependency)
- Produces: an interactively-authored `repolith.toml` in the target dir; refuses to overwrite an existing manifest unless `--force`

- [ ] **Step 1: Write `src/commands/init.ts`**

```typescript
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function initCommand(dir: string, force: boolean): Promise<void> {
  const target = join(dir, 'repolith.toml');
  if (existsSync(target) && !force) {
    throw new Error(`repolith.toml already exists at ${target} — use --force to overwrite`);
  }

  const rl = createInterface({ input, output });
  try {
    const name = (await rl.question('Workspace name: ')).trim() || 'my-workspace';
    const blocks: string[] = [`[workspace]\nname = "${name}"\n`];

    console.log('\nAdd repos (blank repo name to finish):');
    for (;;) {
      const repoName = (await rl.question('  repo name: ')).trim();
      if (!repoName) break;
      const url = (await rl.question('  url: ')).trim();
      const path = (await rl.question(`  path [repos/${repoName}]: `)).trim() || `repos/${repoName}`;
      const ref = (await rl.question('  ref [main]: ')).trim() || 'main';
      blocks.push(`[[repos]]\nname = "${repoName}"\nurl = "${url}"\npath = "${path}"\nref = "${ref}"\n`);
    }

    await writeFile(target, blocks.join('\n') + '\n', 'utf8');
    console.log(`\nWrote ${target}`);
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 2: Wire into `src/cli.ts`**

```typescript
import { initCommand } from './commands/init.js';

program
  .command('init')
  .description('Interactively create a repolith.toml')
  .option('-d, --dir <path>', 'Directory to create repolith.toml in', '.')
  .option('-f, --force', 'Overwrite an existing repolith.toml')
  .action(async (opts: { dir: string; force?: boolean }) => {
    await initCommand(opts.dir, opts.force ?? false).catch(e => {
      console.error(e.message);
      process.exit(1);
    });
  });
```

- [ ] **Step 3: Smoke-test**

```bash
cd "$(mktemp -d)" && bun run /path/to/repolith/src/cli.ts init
```

Answer the prompts (workspace name, then one repo). Expected: a valid `repolith.toml` is written; running `repolith init` again errors unless `--force`.

- [ ] **Step 4: Commit**

```bash
git add src/commands/init.ts src/cli.ts
git commit -m "feat: repolith init — interactive repolith.toml creator"
```

---

### Task 13: VS Code Extension — Scaffold

**Files:**
- Create: `vscode-extension/package.json`
- Create: `vscode-extension/tsconfig.json`
- 🟡 Create: `vscode-extension/src/extension.ts`

**Interfaces:**
- Produces: installable `.vsix` extension that activates on `repolith.toml` presence

- [ ] **Step 1: Install VS Code extension tooling**

```bash
cd vscode-extension
npm init -y
npm install --save-dev @types/vscode @vscode/vsce typescript esbuild
```

- [ ] **Step 2: Write `vscode-extension/package.json`**

```json
{
  "name": "repolith-vscode",
  "displayName": "repolith — Workspace Composer",
  "description": "Makes a set of git repos feel like one folder",
  "version": "0.1.0",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "activationEvents": ["workspaceContains:repolith.toml"],
  "main": "./dist/extension.js",
  "contributes": {
    "commands": [
      {
        "command": "repolith.sync",
        "title": "Repolith: Sync Repos"
      },
      {
        "command": "repolith.search",
        "title": "Repolith: Search Across Repos"
      }
    ]
  },
  "scripts": {
    "compile": "esbuild src/extension.ts --bundle --outfile=dist/extension.js --external:vscode --platform=node --target=node20",
    "package": "vsce package"
  },
  "devDependencies": {
    "@types/vscode": "^1.85.0",
    "@vscode/vsce": "^2.22.0",
    "esbuild": "^0.20.0",
    "typescript": "^5.3.0"
  }
}
```

- [ ] **Step 3: Write `vscode-extension/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "strict": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 4: Write `vscode-extension/src/extension.ts`**

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext): void {
  console.log('repolith extension active');

  context.subscriptions.push(
    vscode.commands.registerCommand('repolith.sync', () => {
      vscode.window.showInformationMessage('repolith sync: not yet implemented');
    }),
    vscode.commands.registerCommand('repolith.search', () => {
      vscode.window.showInformationMessage('repolith search: not yet implemented');
    }),
  );
}

export function deactivate(): void {}
```

- [ ] **Step 5: Build and verify**

```bash
cd vscode-extension && npm run compile
```

Expected: `dist/extension.js` created, no errors.

- [ ] **Step 6: Commit**

```bash
git add vscode-extension/
git commit -m "feat: vs code extension scaffold"
```

---

### Task 14: VS Code — Workspace Folder Provider

**Files:**
- Create: `vscode-extension/src/workspace.ts`
- 🟡 Modify: `vscode-extension/src/extension.ts`

**Interfaces:**
- Consumes: `vscode.workspace.workspaceFolders`, `repolith.toml` on disk
- Produces: each repo's local path added as a VS Code workspace folder when `repolith sync` command fires; folders removed on deactivate

- [ ] **Step 1: Write `vscode-extension/src/workspace.ts`**

```typescript
import * as vscode from 'vscode';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

interface RepoEntry { name: string; path: string; url: string; ref: string; }

function parseTomlRepos(tomlText: string): RepoEntry[] {
  // Minimal TOML [[repos]] parser — avoids bundling a TOML library into the extension
  const repos: RepoEntry[] = [];
  const repoBlocks = tomlText.split('[[repos]]').slice(1);
  for (const block of repoBlocks) {
    const get = (key: string) => {
      const m = block.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, 'm'));
      return m?.[1] ?? '';
    };
    repos.push({ name: get('name'), url: get('url'), path: get('path'), ref: get('ref') });
  }
  return repos.filter(r => r.name && r.path);
}

export async function addWorkspaceFolders(manifestPath: string): Promise<void> {
  if (!existsSync(manifestPath)) {
    vscode.window.showErrorMessage(`repolith.toml not found: ${manifestPath}`);
    return;
  }
  const manifestDir = resolve(manifestPath, '..');
  const toml = readFileSync(manifestPath, 'utf8');
  const repos = parseTomlRepos(toml);

  const existing = new Set(
    (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath),
  );

  const toAdd: { uri: vscode.Uri; name: string }[] = [];
  for (const repo of repos) {
    const absPath = join(manifestDir, repo.path);
    if (!existsSync(absPath)) {
      vscode.window.showWarningMessage(`repolith: ${repo.name} not cloned yet — run repolith sync`);
      continue;
    }
    if (!existing.has(absPath)) {
      toAdd.push({ uri: vscode.Uri.file(absPath), name: repo.name });
    }
  }

  if (toAdd.length > 0) {
    const start = (vscode.workspace.workspaceFolders?.length ?? 0);
    vscode.workspace.updateWorkspaceFolders(start, null, ...toAdd);
    vscode.window.showInformationMessage(`repolith: added ${toAdd.length} repo folder(s) to workspace`);
  }
}
```

- [ ] **Step 2: Update `vscode-extension/src/extension.ts`**

```typescript
import * as vscode from 'vscode';
import { addWorkspaceFolders } from './workspace.js';
import { join } from 'node:path';

export function activate(context: vscode.ExtensionContext): void {
  console.log('repolith extension active');

  const getManifestPath = (): string | undefined => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) return undefined;
    return join(folders[0].uri.fsPath, 'repolith.toml');
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('repolith.sync', async () => {
      const manifest = getManifestPath();
      if (!manifest) {
        vscode.window.showErrorMessage('repolith: open a folder containing repolith.toml first');
        return;
      }
      await addWorkspaceFolders(manifest);
    }),

    vscode.commands.registerCommand('repolith.search', () => {
      vscode.window.showInformationMessage('repolith search: not yet implemented');
    }),
  );

  // Auto-add folders if repolith.toml is present on activation
  const manifest = getManifestPath();
  if (manifest) {
    addWorkspaceFolders(manifest).catch(console.error);
  }
}

export function deactivate(): void {}
```

- [ ] **Step 3: Build**

```bash
cd vscode-extension && npm run compile
```

Expected: no errors.

- [ ] **Step 4: Manual test in VS Code**

1. Open the parent folder (the one containing `repolith.toml`) in VS Code
2. Press F5 to launch the Extension Development Host (add a `.vscode/launch.json` if needed — standard VS Code extension launch config)
3. Run command `Repolith: Sync Repos` from the command palette
4. Verify the cloned repo folders appear in the Explorer sidebar

- [ ] **Step 5: Commit**

```bash
git add vscode-extension/src/
git commit -m "feat: vs code workspace folder provider — adds repos to sidebar"
```

---

### Task 15: VS Code — Cross-Repo Search

**Files:**
- Create: `vscode-extension/src/search.ts`
- 🟡 Modify: `vscode-extension/src/extension.ts`

**Interfaces:**
- Consumes: `addWorkspaceFolders` (repos must be cloned), `vscode.window.showQuickPick`, `vscode.window.showInputBox`
- Produces: quick-pick list of grep results; selecting a result opens the file at the matched line

- [ ] **Step 1: Write `vscode-extension/src/search.ts`**

```typescript
import * as vscode from 'vscode';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

interface GrepResult {
  label: string;
  detail: string;
  file: string;
  line: number;
  repoName: string;
  repoPath: string;
}

function runGrepInRepo(repoPath: string, repoName: string, pattern: string): GrepResult[] {
  try {
    const raw = execSync(
      `git grep -n --color=never ${JSON.stringify(pattern)}`,
      { cwd: repoPath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    return raw.trim().split('\n').filter(Boolean).map(line => {
      const [filePart, linePart, ...rest] = line.split(':');
      return {
        label: `[${repoName}] ${filePart}:${linePart}`,
        detail: rest.join(':').trim(),
        file: join(repoPath, filePart ?? ''),
        line: Number(linePart ?? 1),
        repoName,
        repoPath,
      };
    });
  } catch {
    return [];
  }
}

export async function crossRepoSearch(workspaceFolders: readonly vscode.WorkspaceFolder[]): Promise<void> {
  const pattern = await vscode.window.showInputBox({ prompt: 'Search pattern (git grep)' });
  if (!pattern) return;

  const allResults: GrepResult[] = [];
  for (const folder of workspaceFolders) {
    if (!existsSync(join(folder.uri.fsPath, '.git'))) continue;
    allResults.push(...runGrepInRepo(folder.uri.fsPath, folder.name, pattern));
  }

  if (!allResults.length) {
    vscode.window.showInformationMessage(`repolith: no matches for "${pattern}"`);
    return;
  }

  const picked = await vscode.window.showQuickPick(allResults, {
    matchOnDetail: true,
    placeHolder: `${allResults.length} matches — select to open`,
  });

  if (!picked) return;

  const doc = await vscode.workspace.openTextDocument(picked.file);
  const editor = await vscode.window.showTextDocument(doc);
  const pos = new vscode.Position(picked.line - 1, 0);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
}
```

- [ ] **Step 2: Wire into `extension.ts`**

Replace the `repolith.search` command registration with:

```typescript
import { crossRepoSearch } from './search.js';

// inside activate():
context.subscriptions.push(
  vscode.commands.registerCommand('repolith.search', async () => {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders?.length) {
      vscode.window.showErrorMessage('repolith: no workspace folders open');
      return;
    }
    await crossRepoSearch(folders);
  }),
);
```

- [ ] **Step 3: Build**

```bash
cd vscode-extension && npm run compile
```

Expected: no errors.

- [ ] **Step 4: Manual test**

1. Launch Extension Development Host (F5)
2. Run `Repolith: Search Across Repos` from command palette
3. Type a search term present in one of the cloned repos
4. Verify quick-pick shows `[repo-name] file:line` entries
5. Select one — verify the file opens at the correct line

- [ ] **Step 5: Package the extension**

```bash
cd vscode-extension && npm run package
```

Expected: `repolith-vscode-0.1.0.vsix` created. Install it with:
```bash
code --install-extension repolith-vscode-0.1.0.vsix
```

- [ ] **Step 6: Commit**

```bash
git add vscode-extension/src/search.ts vscode-extension/src/extension.ts
git commit -m "feat: vs code cross-repo search — git grep → quick-pick → open at line"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Task |
|---|---|
| `repolith.toml` manifest with repos + paths | Task 2 |
| Lockfile with atomic state hash | Task 3 |
| `repolith sync` clone/update + lock write | Task 6 |
| `repolith status` branch/dirty/ahead-behind table | Task 7 |
| `repolith exec` arbitrary command dispatch | Task 8 |
| `repolith grep` parallel dispatch | Task 9 |
| `repolith log` parallel dispatch | Task 10 |
| `repolith diff` parallel dispatch | Task 11 |
| `repolith init` interactive manifest creator | Task 12 |
| VS Code extension scaffold | Task 13 |
| VS Code workspace folder provider | Task 14 |
| VS Code cross-repo search | Task 15 |
| No kernel drivers, no new object model | enforced by architecture |
| Git stays git / GitHub stays GitHub | enforced by architecture |

**Placeholder scan:** None detected — all steps contain complete code.

**Type consistency:**
- `WorkspaceManifest`, `RepoEntry`, `Lockfile`, `LockRepo` defined in Task 1 (`types.ts`) and imported consistently throughout.
- `RepoResult<T>` defined in Task 5 (`runner.ts`) and used in sync/grep/log/diff commands.
- `gitRun` returns `{ stdout: string; stderr: string }` — used consistently.
- `parseManifest(tomlString: string): WorkspaceManifest` — signature matches all callers.

---

## Parallel Safety

> Tasks sharing a color badge touch overlapping files and **cannot run in parallel**.

| Group | Tasks | Shared Files |
|-------|-------|--------------|
| 🔴 | Task 1, Task 6, Task 7, Task 8, Task 9, Task 10, Task 11, Task 12 | `src/cli.ts` |
| 🟡 | Task 13, Task 14, Task 15 | `vscode-extension/src/extension.ts` |

Tasks with no color badge have no file conflicts — safe to parallelize freely.
