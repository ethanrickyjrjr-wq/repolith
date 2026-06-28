# repolith — Research, Prior Art & Design Decisions

> **Naming note (2026-06-27):** the tool was working-named `ws` and is now **`repolith`** (npm-free + brand-clean; `ws` is the npm WebSocket library). Command examples say `repolith`. The "Design We Chose" section below still shows the original `workspace.toml`/`workspace.lock.json` filenames; the canonical names are now `repolith.toml`/`repolith.lock.json` (see CLAUDE.md). Competitor references (`git-ws`, `git-workspace`) are unchanged.

## The Problem We Are Solving

When you have 5+ repos that ship together — a frontend, a backend, a shared library, an infra repo — you need to:

- Know the exact state of all of them together (what commits are deployed)
- Search across all of them at once
- See git status/log/diff without `cd`-ing 5 times
- Make your editor feel like it is one project

Every team working this way has a bespoke bash script collection or a monorepo they hate. The tooling gap is real.

---

## Prior Art Research (re-verified live 2026-06-27)

> **Correction (2026-06-27):** A live re-verification found this section was incomplete and over-optimistic — see `docs/research-findings.md` for the full pass. Key fixes: (1) `git-ws` (c0fec0de, Python) already uses a TOML manifest *and* freezes per-repo SHAs via `git ws manifest freeze`; (2) `git-workspace` (orf, Rust, ~342★) uses the exact filename `workspace.toml`; (3) `meta`'s last release was Apr 2021 (~5 years ago, not "2-3"); (4) the name `ws` is the npm WebSocket library (~108M weekly downloads) and is unusable for this tool — rename pending. The original prior-art notes below were also stamped with a future date (2026-06-28) and so were not actually run as written; treat them as a dated draft.

### meta (npm, mateodelnorte/meta)

README excerpt: "meta is a tool for managing multi-project systems and libraries. It answers the conundrum of choosing between a mono repo or many repos by saying 'both', with a meta repo! meta is powered by plugins that wrap common commands, letting you execute them against some or all of the repos in your solution at once."

**What it does:** JSON `.meta` file lists repos + paths. `meta git status`, `meta git log`, `meta exec "cmd"` dispatch to all repos. Plugin system for extra commands.

**What it lacks:**
- No lockfile, no atomic workspace hash (you cannot pin state)
- No VS Code extension
- No TOML (JSON config)
- Last meaningful maintenance: 2-3 years ago (Travis CI badges, David DM deps)
- No lazy/sparse clone

**Conclusion:** Closest competitor. ws beats it on lockfile + atomic hash + VS Code + modern TS stack.

---

### gita (Python, nosarthur/gita)

What it does: Registers repos by path, shows status table (`gita ll`), delegates git commands. Main value is the color-coded status dashboard.

**What it lacks:**
- Python only -- no JS/TS ecosystem integration
- No manifest file (repos registered in a local DB)
- No lockfile
- No VS Code

**Conclusion:** Great for Python devs. Not relevant to our target (JS/TS teams).

---

### vcstool (dirk-thomas/vcstool)

What it does: ROS ecosystem tool. XML `<vcstools>` config. Imports/exports repo lists. Used in robotics CI.

**What it lacks:** XML, not TOML. No lockfile. No VS Code. Niche ecosystem (ROS).

**Conclusion:** Ignore.

---

### Jujutsu (jj-vcs/jj)

What it is: A better git client. Git-compatible (reads/writes git repos). Better conflict handling, first-class revsets, no index. Does NOT add multi-repo composition.

**Why we are not using it:** It is a single-repo client. It has no answer to "treat 5 repos as one." Also: would replace the user's existing git workflow -- our design principle is "git stays git."

**Why not in SWFL Data Gulf:** Same reason. The project uses standard git. Jujutsu solves a different problem (better UX on a single repo), not the multi-repo composition problem.

---

### Pijul

What it is: Full VCS replacement using patch commutativity theory (categorical semantics, Mimram/Di Giusto 2013). Patches commute, so merge conflicts are theoretically impossible.

**Why we are not using it:** Not git-compatible. Would break GitHub, CI, all existing tooling. Tiny ecosystem. Does not solve multi-repo composition. Theoretical elegance, practical isolation.

**Why not in SWFL Data Gulf:** Same as above. Would require abandoning every vendor integration.

---

## The Design We Chose

### workspace.toml (manifest)

```toml
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
```

Why TOML: Human-readable. Line diffs are clean on add/remove. smol-toml has 0 dependencies.

### workspace.lock.json (lockfile)

```json
{
  "version": 1,
  "repos": {
    "frontend": { "url": "...", "ref": "main", "commit": "abc123def456..." },
    "backend":  { "url": "...", "ref": "main", "commit": "789xyz..." }
  },
  "hash": "sha256-hex-of-sorted-name:commit-lines"
}
```

Why this matters: The hash is an atomic fingerprint of the whole workspace state. Pin it in CI, reproduce it anywhere. Like package-lock.json but for repos.

### CLI Commands

| Command | What it does | Why it matters |
|---|---|---|
| repolith init | Interactive workspace.toml creator | On-ramp |
| repolith sync | Clone missing, fetch+checkout all, write lockfile | Core setup |
| repolith status | Color-coded dirty/clean/branch per repo | Daily driver (gita's killer feature) |
| repolith grep <pat> | Parallel git grep, prefixed output | Code search |
| repolith log | Parallel git log with repo headers | History |
| repolith diff | Parallel git diff with repo headers | Review |
| repolith exec "<cmd>" | Run any shell command in all repos | Power user |

### VS Code Extension

Two features:
1. Workspace folder provider: reads workspace.toml, calls workspace.updateWorkspaceFolders() to add each repo as a VS Code folder. Repos appear in Explorer sidebar. Go-to-definition, find-references work per-repo normally.
2. Cross-repo search: Repolith: Search Across Repos command -- input box -> parallel git grep -> quick-pick list -> opens file at line.

VS Code API key facts (from our design session):
- workspace.updateWorkspaceFolders(start, deleteCount, ...foldersToAdd) -- adds folders dynamically
- Activation event: workspaceContains:workspace.toml -- extension auto-activates when manifest is present
- esbuild bundles the extension (not webpack -- simpler, faster)

---

## Package Choices (re-verified live 2026-06-27 — versions confirmed current)

| Package | Version | Why |
|---|---|---|
| smol-toml | 1.7.0 | TOML 1.1.0, 0 dependencies, TypeScript, 1314 dependents |
| execa | 9.6.1 | Gold standard for spawning processes in Node/Bun, 19600 dependents |
| p-limit | 7.3.0 | Concurrency limiter, 5482 dependents, 1 dependency |
| commander | latest | CLI arg parsing, industry standard |

Note: execa v9 changed some APIs from v8 -- use the v9 docs. The reject: false option is still valid.

---

## What the Gap Actually Is (corrected 2026-06-27)

After the live re-verification (`docs/research-findings.md`), the honest gap is narrower than first written. **TOML manifest and SHA-pinning are NOT unique** — `git-ws` does both. What actually survives as differentiating:

1. **Atomic workspace hash** — a single content-ID for the *entire* multi-repo state. Others pin per-repo SHAs; none collapse the whole set into one fingerprint you can pin, diff, and pass around. This is the one primitive worth building the brand on.
2. **VS Code extension** — editor-native sidebar folders + cross-repo search. No competitor has one.

Table stakes (already shipped by ≥1 competitor — match them, do not claim them as a moat): TOML manifest, parallel dispatch, per-repo SHA pinning, `repolith status`, `repolith exec`.

The genuinely uncontested lane is positioning, not features: every competitor (`meta`, `gita`, `git-ws`, `git-workspace`, `mani`, `canopy`) is a 2021–2024 human-developer tool. **None target AI coding agents / agentic CI, and none expose an MCP interface.** That repositioning is the v0.2 plan — see `docs/plan-v2-mcp-agent.md`.

---

## Monetization Thinking (from design session)

Three revenue layers, smallest to largest:

1. **Open source CLI** -- free, drives adoption, builds brand. This is the thing we build first.

2. **Hosted object CDN** -- once you have a lockfile with commit SHAs, you can pre-fetch + cache the actual git objects at those SHAs. For teams with huge repos (50GB+), a CDN that serves partial clone objects for your exact workspace state is worth money. Like Sourcegraph's batched code intelligence, but for the data plane.

3. **Cross-repo search service** -- Sourcegraph validated this market at $100M+ ARR. A hosted version of repolith grep with an index (not raw git grep) is the SaaS layer. Teams that use ws locally would pay for instant search at scale.

Pricing mental model: open source CLI is the wedge. The CDN and search service are the $10-50/seat/month products.

---

## What the Plan Produces

See docs/plan.md for full task breakdown. High-level:

- Task 1: Project scaffold (package.json, tsconfig, types)
- Task 2: Manifest parser (TOML -> WorkspaceManifest, validated)
- Task 3: Lockfile (read/write + deterministic hash)
- Task 4: Git wrapper (clone/fetch/checkout/currentCommit/run)
- Task 5: Parallel runner (concurrency cap, error capture)
- Task 6: repolith sync
- Task 7: repolith status (added -- color-coded dirty/clean/branch table)
- Task 8: repolith exec (added -- arbitrary command dispatch)
- Task 9: repolith grep
- Task 10: repolith log
- Task 11: repolith diff
- Task 12: repolith init (added -- interactive manifest creator)
- Task 13: VS Code scaffold
- Task 14: VS Code workspace folder provider
- Task 15: VS Code cross-repo search
