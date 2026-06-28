# repolith v0.2 — Agent-Native Repositioning + MCP Server

> **Status:** roadmap-plan (hypothesis), depends on v0.1 (`docs/plan.md`). Written 2026-06-27.
> **Why this exists:** the live research (`docs/research-findings.md`) found the human-developer multi-repo niche is already occupied (`meta`, `gita`, `git-ws`, `git-workspace`, `mani`, `canopy`) and never monetized. The one uncontested lane is **agents + CI + MCP** — none of those tools target it. v0.2 is the repositioning, not a feature-polish pass.

---

## The thesis

> **git pins a repo. `repolith` pins a *system* — deterministically, for machines.**

The v0.1 atomic workspace hash is a fingerprint of an entire multi-repo state. For a human that's a nice-to-have. For an **AI coding agent** or an **agentic CI job**, "reconstruct this exact N-repo state, then work, then prove you didn't drift" is a hard requirement that nothing on the market serves. That's the wedge — and machines have budgets that free-CLI humans don't.

| | v0.1 framing (occupied market) | v0.2 framing (open lane) |
|---|---|---|
| Pitch | "make 5 repos feel like one monorepo" | "deterministic multi-repo state for agents & CI" |
| Hero artifact | sidebar folders in VS Code | the atomic hash + an MCP server |
| Buyer | a developer who hates `cd`-ing | an agent platform / a CI budget / a team lead |
| Competitors | meta, gita, git-ws, git-workspace | **none** |

---

## Hard dependency this exposes (pull-forward from v0.1)

v0.1 *writes* `repolith.lock.json` but has **no command to restore from it** (see `docs/plan-review.md` gap #3). The hash is write-only. Every v0.2 feature needs restore-from-state, so it is **Task A here** — and it also fixes the v0.1 `gitCheckout` bug (gap #4: `checkout <ref>` + `pull --ff-only` breaks on a pinned SHA / detached HEAD).

---

## Verified vendor facts (live 2026-06-27 — re-verify at build time per rule #1)

- **MCP TS SDK:** `@modelcontextprotocol/sdk` — latest **1.29.0**. **Use the 1.x line; v2 is pre-alpha** (stable v2 anticipated Q3 2026 — do not build on it yet).
- Server API: `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`; `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`; tools via `server.registerTool(name, { description, inputSchema }, handler)`; schemas via **Zod**.
- ⚠️ **Confirm at build time:** whether `inputSchema` takes a raw Zod shape (`{ pattern: z.string() }`) or a wrapped `z.object({...})` for the installed 1.x version. The code below uses the **raw-shape** form; do not ship without checking the pinned SDK's README. Empty-input tools use `inputSchema: {}`.

New deps for v0.2: `@modelcontextprotocol/sdk@^1.29.0`, `zod`.

---

## Scope

| Task | Ships | Why |
|---|---|---|
| **A** | `repolith checkout` — restore whole system to the locked state (+ fix `gitCheckout`) | the missing primitive everything needs |
| **B** | `repolith mcp` — MCP server exposing the workspace to agents (the headline) | the uncontested lane |
| **C** | `repolith bisect` — find the (repo, commit) across the system that broke a test | the killer demo |
| **D** | `repolith freeze` / `repolith open` — portable, shareable workspace state files | turns the hash into a verb |
| **E** | `--json` + non-interactive everywhere | makes every command agent-callable |

---

### Task A: `repolith checkout` — deterministic system restore

**Files:** Create `src/commands/checkout.ts`; add `gitCheckoutCommit` to `src/git.ts`; 🔴 Modify `src/cli.ts`.

**Interfaces:**
- `gitCheckoutCommit(repoDir, sha)` — `git checkout --detach <sha>` (no pull; SHA is authoritative)
- `checkoutCommand(manifestPath)` — clone-if-missing, fetch, detach to each locked commit, **verify** restored HEADs and recompute the hash; fail loudly if the restored hash ≠ the lockfile hash

- [ ] **Step 1: Add `gitCheckoutCommit` to `src/git.ts`** (fixes v0.1 gap #4 — never `pull` onto a pinned commit)

```typescript
export async function gitCheckoutCommit(repoDir: string, sha: string): Promise<void> {
  await git(repoDir, ['checkout', '--detach', sha]);
}
```

- [ ] **Step 2: Write `src/commands/checkout.ts`**

```typescript
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

  const results = await runAll(manifest.repos, async (repo) => {
    const locked = lock.repos[repo.name];
    if (!locked) throw new Error(`repo "${repo.name}" is not in the lockfile`);
    const dest = join(manifestDir, repo.path);
    if (!existsSync(dest)) await gitClone(repo.url, dest, repo.ref);
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
    if (!r.ok) { console.error(`  ERROR ${r.repo.name}: ${r.error.message}`); anyError = true; }
    else restored[r.repo.name] = { url: r.repo.url, ref: r.repo.ref, commit: r.value };
  }
  if (anyError) process.exit(1);

  const hash = computeHash(restored);
  if (hash !== lock.hash) {
    throw new Error(`restored hash ${hash.slice(0, 12)} != lockfile hash ${lock.hash.slice(0, 12)} — refusing to claim reproducibility`);
  }
  console.log(`Workspace restored to ${hash.slice(0, 12)}… (${manifest.repos.length} repos, detached at locked commits)`);
}
```

- [ ] **Step 3: Wire `repolith checkout` into `src/cli.ts`** (same pattern as the other commands).
- [ ] **Step 4: Smoke-test** — `repolith sync`, note the hash; dirty a repo / move it forward; `repolith checkout`; confirm the printed hash equals the lockfile hash.

> **Known edge (note in code review):** v0.1 `gitClone` uses `--single-branch --branch <ref>`, so a locked commit not reachable on that branch won't be present after a fresh clone. For the agent path, clone full (`gitClone` without `--single-branch`) or `git fetch origin <sha>`. Decide before shipping.

---

### Task B: `repolith mcp` — the MCP server (headline)

**Files:** Create `src/mcp.ts`; 🔴 Modify `src/cli.ts`; add SDK + zod deps.

**Interfaces:**
- `startMcpServer(manifestPath, { allowWrite })` — stdio MCP server. **Read tools always on; mutating tools gated behind `--allow-write` (off by default).** `repolith exec` is intentionally **not** exposed over MCP (arbitrary command execution driven by a model is the wrong default).

**Tool surface:**

| Tool | Kind | Purpose |
|---|---|---|
| `repolith_state` | read | atomic hash + every repo's pinned commit (the system fingerprint) |
| `repolith_status` | read | branch / dirty / ahead-behind per repo (structured) |
| `repolith_grep` | read | regex across all repos, grouped by repo |
| `repolith_diff` | read | per-repo diff |
| `repolith_checkout` | **write (gated)** | restore the system to the locked state |

- [ ] **Step 1: Write `src/mcp.ts`** (core shown; `repolith_status`/`repolith_diff` follow the same shape)

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from './manifest.js';
import { computeHash } from './lockfile.js';
import { gitRun } from './git.js';
import { runAll } from './runner.js';
import { checkoutCommand } from './commands/checkout.js';
import type { LockRepo } from './types.js';

export async function startMcpServer(
  manifestPath: string,
  opts: { allowWrite: boolean },
): Promise<void> {
  const manifestDir = resolve(manifestPath, '..');
  const server = new McpServer({ name: 'repolith', version: '0.2.0' });
  const loadManifest = async () => parseManifest(await readFile(manifestPath, 'utf8'));
  const json = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] });

  // READ — the deterministic system fingerprint
  server.registerTool(
    'repolith_state',
    { description: 'Atomic workspace hash + each repo\'s pinned commit — the deterministic fingerprint of the whole multi-repo system.', inputSchema: {} },
    async () => {
      const manifest = await loadManifest();
      const results = await runAll(manifest.repos, async (repo) => {
        const { stdout } = await gitRun(join(manifestDir, repo.path), ['rev-parse', 'HEAD']);
        return stdout.trim();
      });
      const repos: Record<string, LockRepo> = {};
      for (const r of results) if (r.ok) repos[r.repo.name] = { url: r.repo.url, ref: r.repo.ref, commit: r.value };
      return json({ hash: computeHash(repos), repos });
    },
  );

  // READ — cross-repo grep, structured
  server.registerTool(
    'repolith_grep',
    { description: 'Search a regex across every repo. Returns matches grouped by repo.', inputSchema: { pattern: z.string() } },
    async ({ pattern }) => {
      const manifest = await loadManifest();
      const results = await runAll(manifest.repos, async (repo) => {
        const { stdout } = await gitRun(join(manifestDir, repo.path), ['grep', '-n', '--color=never', pattern])
          .catch(() => ({ stdout: '', stderr: '' }));
        return stdout;
      });
      const matches: { repo: string; hits: string[] }[] = [];
      for (const r of results) {
        if (r.ok && r.value.trim()) matches.push({ repo: r.repo.name, hits: r.value.trim().split('\n') });
      }
      return json(matches);
    },
  );

  // WRITE — gated. Restore the entire system to the locked state.
  if (opts.allowWrite) {
    server.registerTool(
      'repolith_checkout',
      { description: 'Restore every repo to the commits pinned in repolith.lock.json (deterministic system checkout). Mutates working trees.', inputSchema: {} },
      async () => {
        await checkoutCommand(manifestPath);
        return json({ ok: true, message: 'workspace restored to locked state' });
      },
    );
  }

  await server.connect(new StdioServerTransport());
}
```

- [ ] **Step 2: Wire into `src/cli.ts`**

```typescript
import { startMcpServer } from './mcp.js';

program
  .command('mcp')
  .description('Run repolith as an MCP server (stdio) so AI agents can query and restore workspace state')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .option('--allow-write', 'Expose mutating tools (repolith_checkout); off by default', false)
  .action(async (opts: { manifest: string; allowWrite?: boolean }) => {
    await startMcpServer(opts.manifest, { allowWrite: opts.allowWrite ?? false });
  });
```

- [ ] **Step 3: Test with a real MCP client** — register in Claude Code via `claude mcp add repolith -- bun run /path/to/repolith/src/cli.ts mcp --manifest /path/to/repolith.toml`, then ask the agent to call `repolith_state`. Confirm read tools appear and `repolith_checkout` is absent unless `--allow-write`.

> **Security posture (defensive default):** read-only by default; one explicit `--allow-write` flag gates *all* mutation; `repolith exec` never exposed over MCP. Document this in the README — an MCP server an agent can drive must be safe out of the box.

---

### Task C: `repolith bisect` — cross-repo regression finder (the demo)

**Files:** Create `src/commands/bisect.ts`; 🔴 Modify `src/cli.ts`.

Single-repo `git bisect` is solved; **cross-repo bisect is not, and it's a killer demo.** Given a known-good workspace state, a known-bad one (default: current), and a test command, find the single (repo, commit) across the *whole system* that introduced the failure.

**Algorithm (phased — full spec is a follow-up):**
1. For each repo, list commits between good[repo] and bad[repo] (`git rev-list good..bad`).
2. Merge into one timeline ordered by commit timestamp (`--format=%cI`). Each timeline point = a combined system state.
3. Binary search the timeline: at each midpoint, `repolith checkout` that combined state (reuses Task A), run the test command via `execa`, mark good/bad.
4. Report the first bad point: `repo@commit` + author + subject.

**Interface:** `bisect --good <hash> [--bad <hash>] --test "<cmd>"` → prints the offending `repo@sha`.

> **Honesty flag:** interleaving commit timelines across repos with independent histories is genuinely hard (clock skew, non-comparable histories, combined states that never actually co-existed). Ship a **conservative v1**: bisect along the timeline, mark any failing-to-build combined state as "skip" (mirror `git bisect skip`), and document that it finds *a* breaking point, not a provably-minimal one. Don't oversell it.

---

### Task D: `repolith freeze` / `repolith open` — shareable system state

**Files:** Create `src/commands/freeze.ts`, `src/commands/open.ts`; 🔴 Modify `src/cli.ts`.

- `repolith freeze` → writes a portable `repolith.state.json` (urls + pinned commits + hash) — a self-contained snapshot you can commit, attach to a PR, or paste a link to.
- `repolith open <file|url>` → reconstructs that exact system (clone + `gitCheckoutCommit`), then verifies the recomputed hash matches. Paste a state file in Slack → teammate or agent gets the identical N-repo state.

> **Honest correction to the earlier pitch:** you **cannot** reconstruct a workspace from a bare sha256 — the hash is one-way; it's an *integrity check*, not the payload. Offline, you share the **state file** (hash verifies it). "Paste one short hash, get the workspace" only works with a **hosted registry that maps hash → state** — and *that registry is the monetizable server* (ties directly to the `plan-review.md` monetization thesis: sell the thing that owns the lockfile).

---

### Task E: agent/CI ergonomics — `--json` everywhere

**Files:** 🔴 Modify each `src/commands/*.ts` + `src/cli.ts`.

Add a global `--json` flag so `status`, `grep`, `log`, `diff`, `state` emit structured JSON (human tables stay the default for TTYs). Guarantee: every command is non-interactive unless it's `init`, exits non-zero on any repo failure, and never prompts when `--json` is set. This is the cheap, unglamorous work that makes repolith scriptable by an agent or a CI step at all.

---

## Self-Review — spec coverage

| Requirement | Task |
|---|---|
| Restore whole system from lockfile | A |
| Fix `gitCheckout` for pinned SHA / detached HEAD | A |
| MCP server exposing workspace to agents | B |
| Read-only-by-default security posture | B |
| Cross-repo bisect | C |
| Portable, verifiable shareable state | D |
| `--json` / non-interactive for CI & agents | E |
| Repositioning vs. occupied human-dev niche | thesis |

## Parallel safety

All of A/B/C/D/E touch `src/cli.ts` → 🔴 same conflict group as the v0.1 command tasks; serialize the `cli.ts` edits. `src/mcp.ts`, `src/commands/checkout.ts`, etc. are otherwise independent files.

## Open decisions for Ricky

1. **Name** — ✅ **CHOSEN: `repolith`** (2026-06-27). `ws` was taken on npm (WebSocket lib) and `git-ws` too; `repolith` was verified npm-free + brand-clean. MCP server name is `repolith`; manifest is `repolith.toml`, lockfile `repolith.lock.json`.
2. **Ship order** — recommend A → B first (restore + MCP is the whole repositioning and demos in one sitting), then C as the marketing demo, D/E as polish.
3. **MCP transport** — stdio first (local agents: Claude Code/Desktop). Add streamable-HTTP only if a hosted/remote story materializes (and re-verify that SDK surface live then).
