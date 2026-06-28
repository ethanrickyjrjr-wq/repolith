# repolith

> Make a set of independent git repos feel like one monorepo — without touching git internals, GitHub, or CI.

**Status: v0.2 — CLI + MCP server.** All CLI commands (`sync`, `checkout`, `status`, `grep`, `log`, `diff`, `exec`, `init`, `bisect`) are implemented and tested, plus an **MCP server** (`repolith mcp`) so AI agents can query and restore workspace state, and a VS Code extension. APIs may still change pre-1.0.

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

## Quick start

```bash
repolith init                # interactively create repolith.toml
repolith sync                # clone/checkout every repo, write the lockfile
repolith status              # branch + dirty/clean + ahead/behind, per repo
repolith grep "TODO"         # search across all repos at once
repolith exec "npm test"     # run a command in every repo
repolith checkout            # restore every repo to the locked commit (deterministic)
repolith bisect --good good.lock.json --test "npm test"  # find the repo+commit that broke the system
```

## For AI agents (MCP)

`repolith` ships an [MCP](https://modelcontextprotocol.io) server so coding agents can query and reconstruct multi-repo state deterministically — *git pins a repo; repolith pins a system.*

```bash
# register with Claude Code (read-only by default)
claude mcp add repolith -- repolith mcp --manifest /path/to/repolith.toml
```

Tools exposed: `repolith_state` (atomic hash + per-repo commits), `repolith_status`, `repolith_grep`, `repolith_diff`. The mutating `repolith_checkout` is only exposed with `--allow-write`; `exec` is never exposed.

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
