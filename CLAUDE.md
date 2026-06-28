# repolith — Multi-Repo Workspace Composer

## What This Is

`repolith` is a CLI + VS Code extension that makes a set of independent git repos feel like one monorepo. No kernel drivers. No new object model. No patch theory. Git stays git, GitHub stays GitHub, CI stays CI.

Four pieces:
1. `repolith.toml` — manifest declaring which repos belong together and where they live
2. `repolith.lock.json` — lockfile with each repo's pinned commit SHA + an atomic workspace hash
3. CLI (`repolith sync`, `repolith status`, `repolith grep`, `repolith log`, `repolith diff`, `repolith exec`, `repolith init`) — dispatches in parallel, unified output
4. VS Code extension — repos appear as sidebar folders, cross-repo quick-pick search

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
