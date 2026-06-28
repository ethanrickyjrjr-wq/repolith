# repolith — Plan Review: Why It's Good, What It Solves, How We Monetize

> **Naming note (2026-06-27):** reviewed under the working name `ws`; the tool is now **`repolith`** (npm-free + brand-clean). Command examples say `repolith`; remaining bare `ws` references are this review's historical prose about the former name (including the brand caveat that flagged the collision in the first place).

> Written 2026-06-27. No sugar-coating version. The plan is good but it is **not the plan the rest of the docs think it is** — read the "Gaps" section before anyone runs it task-by-task.

---

## Verdict up front

`ws` is a genuinely good idea aimed at a real, unsexy pain, and the plan is unusually clean — TDD per task, complete code in every step, no placeholders, a self-review table, and explicit parallel-safety groups. An agent could execute it.

But: **plan.md builds 4 of the 7 commands the product promises.** It ships `sync`, `grep`, `log`, `diff`. It silently drops `status`, `exec`, and `init` — which `CLAUDE.md` and `research.md` both name as the daily driver, the power-user feature, and the on-ramp. If you build plan.md as written, you ship a multi-repo tool with no `repolith status`. That's the headline. Everything else is secondary.

---

## What ws actually solves

The problem is real and almost everyone with 5+ shipping-together repos has it:

- **State is invisible across repos.** "What's actually deployed right now?" means `cd`-ing into 5 dirs and running `git rev-parse HEAD` five times. There is no single artifact that says "the whole system is at *this* state."
- **No reproducibility across the set.** Each repo has a commit; the *combination* has nothing. You can't pin "frontend@abc + backend@def + shared@ghi" as one unit, hand it to CI, and reproduce it elsewhere.
- **Search and history are per-repo.** Find-references, grep, log, diff all stop at the repo boundary.
- **The editor doesn't believe the repos are one project.** You either open 5 windows or hand-maintain a `.code-workspace`.

The two real options today are both bad: a pile of bespoke bash scripts, or a monorepo migration the team doesn't want (and that breaks per-repo CI, ownership, and access control).

**ws's wedge: keep git, GitHub, and CI exactly as they are, and add a thin composition layer on top.** No kernel drivers, no new object model, no patch theory. That "git stays git" constraint is the single best decision in the whole design — it's why this is adoptable in an afternoon instead of a quarter.

---

## Why the plan is good (the real strengths, not flattery)

1. **The lockfile + atomic workspace hash is the actual novel primitive.** `package-lock.json` for *repos*. A sha256 over sorted `name:commit` lines is a one-line, deterministic fingerprint of the entire multi-repo state. This is the thing no competitor has and the thing every downstream monetization idea hangs off of. It's also dead simple — no cleverness to maintain.

2. **"Shell out to system git" is the right laziness.** No libgit2/nodegit binding to keep alive across Node/Bun versions and platforms. The tool inherits the user's git, credentials, SSH config, and hooks for free. Lower surface area = lower maintenance = it survives.

3. **TDD-per-task with complete code.** Every task writes failing tests first, then the implementation, then verifies green. The runner's error-capture test (one repo throws, the others still succeed) and the hash determinism test (insertion-order independence) are exactly the two behaviors that would otherwise bite later. This is a plan written by someone who has been burned.

4. **Parallelism is correct, not bolted on.** `p-limit` cap of 8, `REPOLITH_CONCURRENCY` override, per-repo `RepoResult<T>` discriminated union so one repo's failure never takes down the batch. The `runAll` abstraction is the spine and it's clean.

5. **The VS Code play is native, not a hack.** `workspace.updateWorkspaceFolders()` + `workspaceContains:workspace.toml` activation means repos appear in the sidebar with zero `.code-workspace` file. esbuild over webpack. This is the differentiator competitors don't bother with, and it's the part users *see*.

6. **Stack discipline.** Zero-dep `smol-toml`, `execa` (19k dependents), `p-limit`, `commander`. Nothing exotic. Nothing that rots.

---

## Gaps — where the plan is wrong or incomplete (read this before building)

This is the partner-in-crime part. The plan has problems the self-review missed.

> **Resolution status (updated 2026-06-27 — fixes applied after this review):**
> - **#1 (4 of 7 commands):** ✅ RESOLVED — `plan.md` is now 15 tasks / 7 commands (`status` = Task 7, `exec` = Task 8, `init` = Task 12); self-review + parallel tables updated; `research.md` and `CLAUDE.md` reconciled.
> - **#2 (future-dated verification):** ✅ RESOLVED — `research.md` dates corrected to 2026-06-27, prior-art claims fixed; full live re-check in `docs/research-findings.md`.
> - **#3 (no restore-from-lockfile):** ➡️ SCHEDULED — `repolith checkout` is Task A of `docs/plan-v2-mcp-agent.md`.
> - **#4 (`gitCheckout` breaks on pinned SHA / detached HEAD):** ➡️ SCHEDULED — fixed alongside Task A (`gitCheckoutCommit`) in the v0.2 plan.
> - **#6 (vitest vs bun):** ✅ RESOLVED — `plan.md` now says Bun test runner.
> - **#5 (smoke tests clone github.com):** ⬜ OPEN — still uses live public repos; switch to a local bare repo.
>
> The findings below are kept as the original review record.

### 1. 🔴 plan.md builds 4 commands; the product promises 7. (Discrepancy)

- `CLAUDE.md` (project source of truth): CLI is `repolith sync, repolith status, repolith grep, repolith log, repolith diff, repolith exec, repolith init` — **7 commands**.
- `research.md` "CLI Commands" table: same 7. Its "What the Plan Produces" section describes a **15-task plan** with Task 7 = `repolith status`, Task 8 = `repolith exec`, Task 12 = `repolith init`.
- `plan.md` (the thing an agent actually executes): **12 tasks, 4 commands.** No `status`, no `exec`, no `init`. Its own self-review coverage table only lists sync/grep/log/diff and doesn't notice the other three are missing.

So the build spec and the design doc describe **different products**. research.md says the plan produces 15 tasks; plan.md is 12. **An agent running plan.md task-by-task ships a tool missing its advertised daily driver (`status`), its on-ramp (`init`), and its power feature (`exec`).** `repolith status` is literally what research.md calls "gita's killer feature" and "daily driver" — and it's not in the build.

**Fix:** Reconcile the two docs. Either add the three tasks to plan.md (it's ~3 more tasks in the exact mold of the existing ones — they're all `parseManifest → runAll(gitRun) → format` except `init` which is an inquirer-style prompt → write TOML), or explicitly scope them to v0.2 in writing so it's a decision, not an accident. Right now it's an accident.

### 2. research.md is "verified" with a future date.

It stamps prior-art as "crawl4ai verified 2026-06-28" and package versions "verified live 2026-06-28." **Today is 2026-06-27.** A verification dated tomorrow did not happen. Per our own rule — committed docs are hypotheses, not authority — every competitor claim and every pinned version in research.md is **unverified** until re-checked live. (That's what the research pass after this file is for.)

### 3. `repolith checkout`/restore-from-lockfile is missing, which guts the lockfile's point.

The plan *writes* `workspace.lock.json` but nothing *reads it to restore state*. `sync` always moves repos to the manifest `ref` (a moving branch), not to the locked `commit`. So the headline feature — "pin it in CI, reproduce it anywhere" — has no command. You can produce the fingerprint but you can't `repolith sync --locked` to reconstruct it. **This is the most important missing command and it isn't even in the 7.**

### 4. `gitCheckout` does `checkout <ref>` then `pull --ff-only` — that fights the lockfile and breaks on detached HEAD.

If `ref` is a SHA or tag (which is the whole reproducibility story), `git pull` is wrong. And `pull --ff-only` silently fails the moment local history diverges. The wrapper assumes `ref` is always a clean branch.

### 5. Smoke tests clone live public repos (octocat/Hello-World).

Tasks 6–9 verify by cloning from github.com. That makes the suite network-dependent and flaky. The git wrapper test already shows the right pattern (a local bare repo, zero network) — the command smoke tests should reuse it.

### 6. Stated stack vs. plan drift: vitest vs. bun test.

`plan.md` line 10 names `vitest`; every task uses `bun:test`; `CLAUDE.md` says Bun test runner. Minor, but it's the same "docs disagree with the build" pattern as #1. Pick one.

None of these are fatal. #1 and #3 are the two that change what you actually ship.

---

## Monetization — the honest take

We build open on GitHub. Good — for a dev CLI, open source *is* the distribution strategy; a closed multi-repo tool is dead on arrival. But "open source + a SaaS later" is where most dev tools go to quietly not make money, so here's the real read on research.md's three layers.

### research.md's plan (for reference)
1. Open-source CLI (free, the wedge).
2. Hosted object CDN — cache git objects at the lockfile's SHAs, serve partial clones for huge repos.
3. Cross-repo search SaaS — indexed `repolith grep` at scale (cites Sourcegraph at $100M+ ARR).

### My honest assessment

- **The wedge is right; the conversion story is the hard part.** The two closest analogs — `meta` and `gita` — are both open source and **neither ever monetized.** Open-core dev CLIs convert at low single-digit percentages *at best*, and only when the paid layer solves a problem the free tool actively creates. So the question isn't "is the CLI good," it's "what expensive problem does adoption manufacture that we can then sell the cure to."

- **Layer 3 (search SaaS) walks straight into Sourcegraph's moat.** research.md cites Sourcegraph's $100M ARR as *encouraging*. It's the opposite — it's a well-funded incumbent that already owns "search across all your code," already indexes multi-repo, and would regard us as a feature. Charging *at* a $100M incumbent with a `git grep` wrapper is the weakest of the three. Drop it or radically narrow it.

- **Layer 2 (object CDN) is real but it's a different, harder company.** A git-object CDN is infra: egress costs, cache invalidation, auth against private repos, 24/7 reliability. It's a genuinely valuable thing for 50GB-monorepo teams — but it's GitLFS/partial-clone-CDN territory, a capital-intensive infra business, not a weekend SaaS bolt-on. Don't pretend it's adjacent to shipping a CLI. It's a pivot.

### What I'd actually pursue (in order)

1. **`ws` for AI agents / CI as the real wedge.** The lockfile + atomic hash is *exactly* what an agent or a CI job needs to say "reconstruct this precise multi-repo state, deterministically." That's the differentiated use case nobody owns: reproducible multi-repo checkouts for agentic coding and CI matrices. This reframes the lockfile from "nice for humans" to "required for machines" — and machines have budgets.

2. **Team sync server (the boring SaaS that actually converts).** A hosted endpoint that holds the *blessed* `workspace.lock.json` for a team: "everyone on the team, get to the exact state the lead just pushed." Slack/CI notifications when the workspace hash changes. Drift detection ("3 of your repos are behind the locked state"). This is small, it's sticky, it's per-seat, and crucially it's a problem the free CLI *creates* (now that a team shares a workspace, they need a shared source of truth for it). $5–10/seat/mo. Unsexy, plausible.

3. **VS Code extension as the paid surface, not the CLI.** The CLI should be 100% free forever (it's the distribution). Premium features live in the editor — hosted cross-repo index, blame/ownership across repos, "who else is in this workspace state." People pay for editor features in a way they never pay for a terminal binary.

4. **Defer the CDN.** It's the biggest TAM and the worst first move. Only build it once a meaningful number of teams are already pinning lockfiles and hitting clone-time pain — i.e., let layer 1 + the sync server *prove* the pain exists before raising infra money to solve it.

**Brand/distribution caveat that affects all of this:** before we commit to the name, we have to confirm `ws` is even installable under that name on npm (see the research note that follows this file). If the bin/name collides, the go-to-market and the README change on day one.

### One-line monetization thesis

> The CLI is free and exists to make teams depend on a shared `workspace.lock.json`. We sell the *server that owns that lockfile* (team sync, drift detection, agent/CI reproducibility) — not a `git grep` wrapper that picks a fight with Sourcegraph.

---

## What to do next (concrete)

1. **Reconcile plan.md ↔ research.md ↔ CLAUDE.md on the command set.** Decide: are `status`/`exec`/`init` v0.1 or v0.2? Put it in writing. (Recommend: at least `status` and `init` are v0.1 — without them ws is "meta with a lockfile.")
2. **Add `repolith sync --locked` (restore-from-lockfile).** Without it the lockfile is write-only and the reproducibility pitch is hollow.
3. **Fix `gitCheckout` for SHA/tag refs and detached HEAD.**
4. **Re-verify everything in research.md live** (next file) — competitors, package versions, and the killer question: is the name `ws` even available?
5. Make command smoke tests use a local bare repo, not github.com.
