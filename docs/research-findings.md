# repolith — Live Research Findings (does it exist? how do we differentiate?)

> **Naming note (2026-06-27):** the tool was working-named `ws` during this research and has since been **renamed to `repolith`** (verified npm-free + brand-clean). Command examples now say `repolith`; the many `ws` / `git-ws` references that remain below are the *historical* analysis of why `ws` (npm WebSocket lib) and `git-ws` (existing tool) were unusable — left intact on purpose. Competitor names (`git-ws`, `git-workspace`) are unchanged.

> Run 2026-06-27 with **Firecrawl / WebSearch / direct npm-registry fetches**, in-session, per the vendor-first rule. Note: there is no literal "crawl4ai" tool wired into this session — "send out crawl4ai" was executed as live web research with the tools actually available. Everything below was verified live today, not taken from `research.md` (whose own checks are stamped 2026-06-28 — a future date — and therefore did not happen as written).
>
> **Dark web:** declined, intentionally. There is no legitimate prior-art for a developer CLI on .onion sites, and Ricky's "don't bring back any diseases" is the instruction to stay out. No cycles spent there. 🦠🚫

---

## TL;DR (the no-sugar version)

1. **The name `ws` is dead on arrival.** On npm, `ws` is the WebSocket library — ~108M weekly downloads, the de-facto Node standard. We can't publish under it and the `ws` bin likely collides. **Rename before anything else.**
2. **The concept is crowded, not novel.** At least six tools already compose multiple git repos from a manifest: `meta`, `gita`, `git-ws`, `git-workspace`, `mani`, `canopy`. Several use a **TOML** manifest. One (`git-workspace`) uses the exact filename **`workspace.toml`** we picked.
3. **The "lockfile + SHA pinning" moat already exists.** `git-ws` has `git ws manifest freeze` → resolved manifest with SHAs. So research.md's headline claim — *"None do: TOML manifest + lockfile + atomic hash + VS Code"* — is **wrong on the first three**.
4. **What's genuinely still ours:** the *single atomic workspace hash* (one content ID for the whole multi-repo state) and the *VS Code extension*. Real, but thin. Not a business by themselves.
5. **Where the actual open lane is:** every one of these tools is a 2021–2024-era *human-developer* tool. **None are built for AI coding agents / agentic CI**, and **none expose an MCP interface.** That's the uncrowded outside-the-box bet.

---

## Finding 1 — The name `ws` is taken (hard blocker)

| | |
|---|---|
| npm package `ws` | the WebSocket client/server for Node.js |
| Latest version | 8.21.0 |
| Weekly downloads | ~108M (one of the most-installed packages on npm) |
| GitHub stars | ~22.3k |

You cannot `npm publish ws`, users cannot `npm i -g ws` to get our tool, and a `ws` binary on PATH will be confused with nothing-in-particular but the package story is finished. **This reshapes branding and the README on day one.** And note the concept-name `git-ws` is *also* already taken (see Finding 2). Both obvious names are gone.

**Name candidates to check for availability (npm + bin + GitHub):** `repostack`, `polyrepo`, `confluence`-no (Atlassian), `manyfold`, `reposet`, `cohort`, `flock`, `gitflock`, `weave`, `loom`, `composite`, `monoish`, `quilt`. (Pick one, then verify it's free with the same registry check used here before committing.)

---

## Finding 2 — Prior art, re-verified live (research.md was optimistic)

| Tool | Lang | Manifest | Pins commit SHAs? | Atomic single hash? | VS Code ext? | Stars | Last update |
|---|---|---|---|---|---|---|---|
| **meta** (mateodelnorte) | JS | `.meta` (JSON) | No | No | No | ~2.2k | **Apr 2021** (v2.2.25) — effectively unmaintained (~5 yrs) |
| **git-ws** (c0fec0de) | Python | **`git-ws.toml` (TOML)** | **Yes** — `git ws manifest freeze` → SHAs | No | No | ~13 | Nov 2023 |
| **git-workspace** (orf) | Rust | **`workspace.toml` (TOML)** | No (Cargo.lock is build deps) | No | No | ~342 | Aug 2024 |
| **gita** (nosarthur) | Python | local DB, no manifest | No | No | No | not re-checked this pass | — |
| **mani** (alajmo) | Go | `mani.yaml` (YAML) | No | No | No | not re-checked this pass | — |
| **canopy** | — | `canopy.toml` (TOML) | worktree-based | No | No | not re-checked this pass | — |
| **ws (this project)** | TS/Bun | `workspace.toml` (TOML) | Yes | **Yes (unique)** | **Yes (unique)** | — | — |

Discrepancy vs. `research.md` (Rule #4):
- research.md: *"None do: TOML manifest + lockfile + atomic hash + VS Code."* → **TOML manifest is done by git-ws, git-workspace, canopy. SHA-pinning (the lockfile's purpose) is done by git-ws.** Only "single atomic hash" and "VS Code" survive that sentence.
- research.md: meta "last meaningful maintenance 2-3 years ago." → It's **5 years** (Apr 2021). Worse than stated, which actually *helps* us — but the doc was wrong.
- research.md package versions (`smol-toml 1.7.0`, `execa 9.6.1`, `p-limit 7.3.0`): **all confirmed current today.** Credit where due — those pins are accurate; only the future-dated stamp was bogus.

---

## Finding 3 — What's genuinely defensible (be honest: it's narrow)

After live checking, exactly two of the planned differentiators are not already shipped by a competitor:

1. **The atomic workspace hash** — a single `sha256` content-ID for the *entire* multi-repo state. git-ws freezes *per-repo* SHAs; nobody collapses the whole set into one fingerprint you can pin, diff, and pass around. This is the one primitive worth building the brand on.
2. **The VS Code extension** — native sidebar folders + cross-repo quick-pick. None of the six have it. This is the part users *see* and the only one with an obvious paid surface.

Everything else (TOML manifest, parallel dispatch, per-repo SHA pin, status table, exec) is table stakes — already in one or more competitors. That's fine; "table stakes done well + Bun-fast + good DX" is a legitimate product. But it is **not** a defensible moat, and the docs should stop pretending it is.

---

## Finding 4 — Outside-the-box: the lane nobody is in

Every tool in the table was designed for a *human* running git in a terminal in 2021–2024. The non-obvious openings — "different ways than the obvious clone":

1. **Agent-native / agentic-CI reproducibility (the real wedge).** The atomic hash is exactly the primitive an AI coding agent or a CI matrix needs to say *"reconstruct this precise multi-repo system state, deterministically, then work."* None of meta/git-ws/git-workspace/mani target agents. Reframe the whole pitch: *git pins a repo; ws pins a system — for agents and CI.* Machines have budgets; humans installing a free CLI don't.

2. **An MCP server (`ws` as a tool an LLM can call).** Expose the workspace over MCP so Claude/agents can natively ask "what's the state of all repos," "diff the whole system," "put everything at hash X." This is dead-on for our stack (TS/Deno/Supabase, MCP-heavy) and **zero competitors have it.** This is the single most "no other Claude would think of this" move on the board.

3. **Workspace state as a shareable ID.** `repolith open <hash>` reconstructs an entire multi-repo dev environment from one fingerprint — paste a hash in Slack, teammate gets the exact system state. Pairs naturally with devcontainers / Codespaces. Turns the hash from an internal detail into the product's verb.

4. **Cross-repo bisect.** `repolith bisect` — find which repo *and* commit, across the whole system, introduced a regression. Single-repo bisect is solved; cross-repo bisect is a genuine unsolved pain and a killer demo.

5. **System time-travel.** `repolith checkout <hash>` puts all N repos at a past known-good combined state in one command — the thing the lockfile *implies* but no command in plan.md actually delivers yet (see plan-review.md gap #3).

Ranking for impact-vs-effort: **#2 (MCP) and #1 (agent framing) first** — they're cheap, on-brand, and uncontested. #4 (bisect) is the best demo. #3/#5 are the long-game brand.

---

## Recommended next moves

1. **Rename.** `ws` and `git-ws` are both taken. Decide a name, verify it free (npm + GitHub + bin) with the same registry check used here.
2. **Reposition around agents/CI + MCP**, not "monorepo feel for humans" — that segment is occupied and unmonetized.
3. **Update `research.md`:** correct the prior-art table (TOML/SHA-pin are not unique), fix the meta date, remove the future-dated "verified" stamps.
4. **Keep the two real differentiators** (atomic hash, VS Code) and add the restore-from-hash command (`repolith checkout <hash>`) so the hash is the product, not a side effect.

---

## Sources (verified live 2026-06-27)

- [ws on npm (the WebSocket library)](https://www.npmjs.com/package/ws) — name collision
- [npm trends: ws](https://npmtrends.com/ws) — download scale
- [git-ws (c0fec0de) on GitHub](https://github.com/c0fec0de/git-ws) and [git-ws docs / manifest](https://git-ws.readthedocs.io/en/2.0.2/manual/manifest.html) — TOML manifest + `manifest freeze` SHA pinning
- [git-workspace (orf) on GitHub](https://github.com/orf/git-workspace) / [crates.io](https://crates.io/crates/git-workspace) — `workspace.toml`, Rust
- [meta (mateodelnorte) on GitHub](https://github.com/mateodelnorte/meta) — last release Apr 2021
- [mani (alajmo) writeup](https://dev.to/alajmo/mani-a-cli-tool-to-manage-multiple-repositories-1eg) — YAML multi-repo CLI
- npm registry latest-version checks: smol-toml 1.7.0, execa 9.6.1, p-limit 7.3.0 (all current)
