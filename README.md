# repolith

> Make a set of independent git repos feel like one monorepo — without touching git internals, GitHub, or CI.

**Status: early / under active development (v0.0.x).** The name is reserved and the core is being built task-by-task. APIs and commands will change until v0.1.

## What it is

`repolith` composes several independent git repositories into one workspace. Git stays git, GitHub stays GitHub, CI stays CI — `repolith` adds a thin layer on top:

- **`repolith.toml`** — a TOML manifest declaring which repos belong together and where they live.
- **`repolith.lock.json`** — a lockfile pinning each repo's commit SHA plus a single **atomic workspace hash**: one content-ID for the entire multi-repo state. Like `package-lock.json`, but for a set of repos.
- **A parallel CLI** — `sync`, `status`, `grep`, `log`, `diff`, `exec`, `init` dispatched across every repo at once.
- **A VS Code extension** — repos appear as sidebar folders with cross-repo search.
- **An MCP server** (planned) — so AI coding agents and CI can reconstruct an exact multi-repo state deterministically.

> The thesis: **git pins a repo; `repolith` pins a *system*.**

## Install

```bash
npm i -g repolith
# or
bun add -g repolith
```

## Quick start (target shape — not all commands shipped yet)

```bash
repolith init                # interactively create repolith.toml
repolith sync                # clone/checkout every repo, write the lockfile
repolith status              # branch + dirty/clean + ahead/behind, per repo
repolith grep "TODO"         # search across all repos at once
repolith exec "npm test"     # run a command in every repo
```

### Example `repolith.toml`

```toml
[workspace]
name = "my-workspace"

[[repos]]
name = "frontend"
url  = "https://github.com/org/frontend.git"
path = "packages/frontend"
ref  = "main"

[[repos]]
name = "backend"
url  = "https://github.com/org/backend.git"
path = "packages/backend"
ref  = "main"
```

## License

MIT © Ricky Cooper
