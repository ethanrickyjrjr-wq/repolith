<p align="center">
  <img src="assets/logo.svg" width="116" alt="repolith logo" />
</p>

<h1 align="center">repolith</h1>

<p align="center"><em>Make a set of independent git repos feel like one monorepo — without touching git internals, GitHub, or CI.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/repolith"><img src="https://img.shields.io/npm/v/repolith?color=5b8def" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/repolith"><img src="https://img.shields.io/npm/dm/repolith?color=5b8def" alt="npm downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=stanicky.repolith-vscode"><img src="https://img.shields.io/visual-studio-marketplace/v/stanicky.repolith-vscode?color=36d6c3&label=VS%20Code" alt="VS Code Marketplace"></a>
  <img src="https://img.shields.io/npm/l/repolith?color=8b6cff" alt="license">
</p>

**Status: v0.3 — CLI + MCP server.** All CLI commands (`sync`, `checkout`, `status`, `grep`, `log`, `diff`, `exec`, `init`, `bisect`, `state`, `freeze`, `open`) are implemented and tested — with `--json` on the read commands — plus an **MCP server** (`repolith mcp`) so AI agents can query and restore workspace state, and a VS Code extension. APIs may still change pre-1.0.

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

**VS Code extension:** search "repolith" in the Extensions view, or install [`stanicky.repolith-vscode`](https://marketplace.visualstudio.com/items?itemName=stanicky.repolith-vscode).

## Quick start

```bash
repolith init                # interactively create repolith.toml
repolith sync                # clone/checkout every repo, write the lockfile
repolith status              # branch + dirty/clean + ahead/behind, per repo
repolith grep "TODO"         # search across all repos at once
repolith exec "npm test"     # run a command in every repo
repolith checkout            # restore every repo to the locked commit (deterministic)
repolith bisect --good good.lock.json --test "npm test"  # find the repo+commit that broke the system
repolith state --json        # print the atomic hash + per-repo commits (scriptable)
repolith freeze snap.json    # write a shareable snapshot of the current state
repolith open snap.json      # reconstruct the exact system from a shared snapshot
```

`status`, `grep`, `log`, `diff`, and `state` all accept `--json` for scripting and agent/CI use.

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
