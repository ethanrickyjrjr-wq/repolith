<p align="center">
  <img src="assets/logo.svg" width="116" alt="repolith logo" />
</p>

<h1 align="center">repolith</h1>

<p align="center"><em>The coordination layer for parallel AI coding agents — plus monorepo ergonomics for multi-repo workspaces.</em></p>

<p align="center">
  <a href="https://github.com/ethanrickyjrjr-wq/repolith/actions/workflows/ci.yml"><img src="https://github.com/ethanrickyjrjr-wq/repolith/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/repolith"><img src="https://img.shields.io/npm/v/repolith?color=5b8def" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/repolith"><img src="https://img.shields.io/npm/dm/repolith?color=5b8def" alt="npm downloads"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=stanicky.repolith-vscode"><img src="https://img.shields.io/visual-studio-marketplace/v/stanicky.repolith-vscode?color=36d6c3&label=VS%20Code" alt="VS Code Marketplace"></a>
  <img src="https://img.shields.io/npm/l/repolith?color=8b6cff" alt="license">
</p>

**Status: v0.4 — coordination layer + multi-repo CLI + MCP server.** Used daily on the author's own workspaces under real parallel-session load. APIs may still change pre-1.0. See [CHANGELOG](CHANGELOG.md).

> git pins a repo. repolith pins a *system* — and coordinates every agent working inside it.

## The problem

You run two or three Claude Code sessions on the same repo. Each one plans, each one edits, each one is individually correct — and then one overwrites the other's half-finished change, or both do the same work, or the merge conflict shows up *after* both have burned an hour of tokens.

The usual answer is worktree isolation. Isolation doesn't prevent the conflict; it defers it to merge time. repolith prevents it at **plan time** and **edit time**.

## What it does

**1. Catches overlapping plans before anyone edits.** When a session leaves plan mode, a hook registers the plan and its blast radius, compares it against every other active session, and injects the overlap into the session's context — same file, same module, or a shared surface like `types.ts` — before the first edit lands. Sessions that write their scope to a spec/plan file get the same treatment.

**2. Gates edits.** The first session to touch a file claims it. A second live session's `Edit`/`Write` of that file is **denied**, with the holder named and the recovery command included. Commands that change files without an `Edit` (`sed -i`, `git checkout`, codegen) are caught after the fact by a Bash backstop.

**3. Resumes automatically.** A denied session runs `repolith claim wait` and acquires the file the instant the holder commits or releases — FIFO, so nobody starves. Mutual waits surface as a named deadlock, not a hang.

**4. Hands over context.** Notes keyed by file — auto-derived from commits, claims, and plans — are shown to a session the moment it first touches something another session has been working on. On resume, a catch-up brief summarises what's in flight.

**5. Stays honest about liveness.** Per-session heartbeats separate "busy elsewhere" from "crashed". Stale claims are released only on git evidence (file clean, holder already committed). Overriding a claim to unblock one session bars the booted session from silently re-taking it.

Nothing here needs the agent to cooperate: capture is by hook, claims are on first touch, and the Bash backstop is reactive. An agent that never declares anything is still coordinated.

## Quick start (coordination)

```bash
npm i -g repolith
cd your-workspace
repolith init                        # one-time: creates repolith.toml (works for a single repo too)
repolith hooks install --post-commit # writes the Claude Code hooks into .claude/settings.json (merged, idempotent)
```

That's it. Open as many Claude Code sessions as you like in that workspace.

```bash
repolith plan list        # active sessions and their declared blast radius
repolith claim list       # who holds which file
repolith claim waits      # the wait graph — spot deadlocks
repolith claim release --stale        # sweep claims that git proves are done
repolith claim wait --file src/x.ts --session <id>   # what a denied session runs to auto-resume
```

Optional manifest settings:

```toml
[coord]
append_only   = ["SESSION_LOG.md"]     # shared logs: appends don't conflict, so don't gate them
spec_patterns = ["docs/specs/*.md"]    # saved spec/plan files register as blast radius
```

### How this compares

| | Worktree isolation | Native agent teams (Claude Code) | Advisory intent protocols (e.g. foremerge) | **repolith** |
|---|---|---|---|---|
| Catches conflicts | at merge | — | before edit, if every agent declares | before edit, and on first touch |
| Blocks a collision | no | no | no (advisory by design) | **yes** (edit gate + Bash backstop) |
| Needs agent cooperation | — | — | yes (must publish intent) | **no** (hooks capture it) |
| Scope | one repo | one session | one repo | **N repos, N sessions** |
| Context handoff | — | task list + mailbox | provenance | journal + read-before-touch + catch-up brief |

## Multi-repo workspaces

The original repolith: compose independent git repos into one workspace without touching git internals, GitHub, or CI.

- **`repolith.toml`** — which repos belong together and where they live.
- **`repolith.lock.json`** — each repo's pinned commit plus one **atomic workspace hash**: a single content-ID for the whole multi-repo state.
- **Parallel CLI** — every command fans out across all repos at once.

```bash
repolith sync                # clone/checkout every repo, write the lockfile
repolith status              # branch + dirty/clean + ahead/behind, per repo
repolith grep "TODO"         # search across all repos
repolith exec "npm test"     # run a command in every repo
repolith checkout            # restore every repo to the locked commit
repolith bisect --good good.lock.json --test "npm test"  # which repo+commit broke the system
repolith state --json        # atomic hash + per-repo commits
repolith freeze snap.json    # shareable snapshot of the whole system
repolith open snap.json      # reconstruct it exactly, anywhere
```

`status`, `grep`, `log`, `diff`, and `state` accept `--json`. **VS Code extension:** [`stanicky.repolith-vscode`](https://marketplace.visualstudio.com/items?itemName=stanicky.repolith-vscode) — repos as sidebar folders, cross-repo search.

Example manifest:

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

## For AI agents (MCP)

```bash
# every server needs an --agent-id; it is read-only unless a repolith.grants.toml grants it more
claude mcp add repolith -- repolith mcp --manifest /path/to/repolith.toml --agent-id claude-frontend
```

Workspace tools: `repolith_state`, `repolith_status`, `repolith_grep`, `repolith_diff`, `repolith_audit`. The mutating `repolith_checkout` is only registered for an agent-id with a `checkout = true` grant; `exec` is never exposed.
Coordination tools (always on — they only touch `.repolith/`): `repolith_register_plan`, `repolith_compare_plans`, `repolith_list_active`, `repolith_claim`, `repolith_check`, `repolith_release`, `repolith_list_claims`, `repolith_wait_claim`.

### Guardrails: per-agent grants + an append-only audit log

More than one `repolith mcp` process can be live against one workspace, so each gets its own identity and its own explicit capabilities — not one global switch.

**`repolith.grants.toml`** — which agent-ids may call which mutating tools. Absent = read-only, whatever agent-id connects:

```toml
[agents.claude-frontend]
checkout = true

[agents.claude-reviewer]
checkout = false   # or omit the agent entirely — same effect
```

```bash
repolith mcp --manifest repolith.toml --agent-id claude-frontend --grants repolith.grants.toml
```

**`repolith.audit.jsonl`** — every tool call (read or write, success or failure, coordination included) is appended as a hash-chained entry `{ts, agentId, tool, args, ok, error, prevHash, hash}`. Rewriting or dropping a past entry breaks the chain from that point on, which `repolith_audit` reports as `verified: false` plus the line it broke at. It catches tampering after the fact; it does not stop two separate `repolith mcp` processes racing on the same log file (only calls within one process are serialized) — a real limitation, not swept under the rug.

## Limitations (read these)

- **Cooperative at the client level.** Coordination rides the client's hook surface. Claude Code is wired today; other clients can use the MCP tools directly.
- **Same machine.** The store is `<workspace>/.repolith/`. Sessions on different machines don't see each other yet.
- **Path-keyed claims.** A rename or move is a new file.
- **Plan overlap over-reports on purpose.** It only warns; the edit gate is what blocks.

## License

MIT © Ricky Cooper
