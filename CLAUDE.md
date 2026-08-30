# repolith — Multi-Repo Workspace Composer

## What This Is

`repolith` is a CLI + MCP server + VS Code extension with two layers:

1. **Coordination layer (`src/coord/`, the headline since v0.4):** coordinates parallel AI coding sessions in one workspace. Plan-time overlap catch via a `PreToolUse` hook on `ExitPlanMode` (plus spec-file registration), an edit gate that claims files on first touch and denies a second live session, a Bash backstop for edits that bypass `Edit`/`Write`, `claim wait` auto-resume with FIFO fairness and deadlock surfacing, a file-keyed journal with read-before-touch and a SessionStart catch-up brief, heartbeats, git-verified staleness, and operator-override revocation. Store is same-machine JSON under `<workspace>/.repolith/`. CLI: `hooks install`, `plan …`, `claim …`. Hooks/commands are wired in `src/commands/{plan,claim,hooks,hook-stdin,bash,spec,session}.ts`; MCP tools in `src/mcp.ts`.
2. **Multi-repo layer:** makes a set of independent git repos feel like one monorepo. No kernel drivers. No new object model. No patch theory. Git stays git, GitHub stays GitHub, CI stays CI.
   - `repolith.toml` — manifest declaring which repos belong together and where they live (optional `[coord]` table: `append_only`, `spec_patterns`)
   - `repolith.lock.json` — lockfile with each repo's pinned commit SHA + an atomic workspace hash
   - CLI (`sync`, `checkout`, `status`, `grep`, `log`, `diff`, `exec`, `init`, `bisect`, `state`, `freeze`, `open`) — dispatches in parallel, unified output
   - VS Code extension — repos appear as sidebar folders, cross-repo quick-pick search

Every hook command must exit 0 on any internal failure — coordination is advisory infrastructure and must never break the user's edit or plan flow.

## Stack

- **Runtime:** Bun >=1.1
- **Language:** TypeScript (strict)
- **Key packages:** `smol-toml@1.7.0` (TOML parse, 0 deps), `execa@9.6.1` (spawn git), `p-limit@7.3.0` (concurrency cap), `commander` (CLI)
- **Tests:** Bun test runner
- **VS Code extension:** esbuild bundle, Node 20, VS Code API >=1.85

## Key Decisions (do not re-litigate)

- Shell out to system `git` -- never wrap libgit2 or nodegit (keeps it maintenance-free)
- TOML manifest, not JSON -- more readable, git-friendly diffs on adds/removes
- Lockfile hash = sha256 of sorted "name:commit" lines -- deterministic, reproducible
- Concurrency cap default = 8, overridable via REPOLITH_CONCURRENCY env var
- VS Code extension uses workspace.updateWorkspaceFolders() -- native API, no .code-workspace file required
- repolith exec runs in each repo's directory, captures stdout/stderr per repo
- MCP write access is per-agent, not a single global flag -- `repolith mcp` now requires `--agent-id` and only registers `repolith_checkout` when `repolith.grants.toml` grants that specific agent-id `checkout = true`; no grants file = read-only regardless of agent-id
- Every MCP tool call (read or write, success or failure) is appended to a hash-chained `repolith.audit.jsonl` -- each entry's hash covers its own fields plus the prior entry's hash, so tampering with a past line is detectable via the always-on `repolith_audit` tool. In-process concurrent calls are serialized before appending; two separate `repolith mcp` processes racing on the same log file is a known, undefended gap (would need an OS file lock) -- not solved in v1

## Prior Art (see docs/research.md + docs/research-findings.md for full notes)

- meta (npm): multi-repo dispatch, JSON config, no lockfile, no VS Code, last release Apr 2021
- gita (Python): status display + dispatch, no lockfile, no JS ecosystem
- git-ws (Python, c0fec0de): TOML manifest (`git-ws.toml`) + `manifest freeze` to per-repo SHAs -- closest on concept AND name
- git-workspace (Rust, orf, ~342*): uses the exact filename `workspace.toml`, syncs GitHub/GitLab/Gitea
- vcstool (Python): ROS robotics tool, XML config
- Jujutsu (jj): better single-repo git client, git-compatible, no multi-repo story
- Pijul: patch-theory VCS, not git-compatible, tiny ecosystem -- wrong tool entirely

What's actually uncontested (live re-verified 2026-06-27): the single **atomic workspace hash**, a **VS Code extension**, and **agent/MCP positioning**. TOML manifest + per-repo SHA pinning are NOT unique (git-ws does both).
NB: the name `ws` was taken by the npm WebSocket library (~108M weekly downloads) -- **renamed to `repolith`** (chosen 2026-06-27: verified npm-free + brand-clean). Manifest file is `repolith.toml`, lockfile `repolith.lock.json`.

## Plan

Full implementation plan with all tasks: docs/plan.md

## Context & Research

All research, prior art, design decisions, monetization thinking: docs/research.md
