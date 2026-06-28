# repolith v0.4+ — Hosted Sync Server (Handoff)

> **Status:** handoff / not started. This is the **monetization layer** — the paid product that sits on top of the free CLI. Pick this up only after the free CLI has real adoption and people are asking to share state across a team. Written 2026-06-28.
>
> **Prereqs already shipped (v0.1–v0.3):** the CLI (`sync, checkout, status, grep, log, diff, exec, init, bisect, state, freeze, open`), the MCP server, the VS Code extension — all live on npm / GitHub / Marketplace at `0.3.1`. The core primitive this server builds on is `repolith.lock.json` + the **atomic workspace hash** (sha256 of sorted `name:commit` lines).

---

## The thesis (why this is the money)

From `docs/plan-review.md`: the CLI is free forever — it drives adoption and makes a team **depend on a shared `repolith.lock.json`**. The moment a team shares a workspace, they need a single source of truth for "what state are we all supposed to be at." **That source of truth is the product.**

> Sell the *server that owns the lockfile* — team sync, drift detection, a hash→state registry. **Not** a hosted `git grep` (that walks straight into Sourcegraph's moat).

One-line pitch: **git pins a repo; repolith pins a system — and this server pins it for your whole team.**

---

## Product surface (what the server enables)

| New CLI command | What it does | Server role |
|---|---|---|
| `repolith login` | authenticate the CLI to a team | issues/stores an API token |
| `repolith push` | publish the current state as the team's blessed state | stores `{workspace, hash, repos}` |
| `repolith pull` | snap to the team's blessed state (then `restoreState`) | returns the blessed state |
| `repolith status --remote` | show drift: local hash vs. blessed hash | returns blessed hash |
| `repolith open <hash>` (bare hash) | reconstruct a system from just a hash | **hash→state registry** resolves it |

Plus, server-side: **drift alerts** (Slack/webhook when the blessed hash changes), and later a **web dashboard** (workspace state, history, who's on what).

> Note: `repolith open <hash>` from a *bare hash* is impossible offline (sha256 isn't reversible — see `plan-v2-mcp-agent.md` Task D). The registry is exactly what makes it work, which is a clean reason the registry has standalone value.

---

## Architecture sketch

**Stack (per global CLAUDE.md — verify all surfaces live before building, rule #1):**
- **Supabase** — Postgres (state storage) + Auth (teams/users). Has an MCP server; use it.
- **Deno / Supabase Edge Functions** — the API (Deno-style imports per the Deno Defaults rule).
- **Vercel + React 19 + Tailwind + Vite** — the eventual dashboard.
- TypeScript throughout.

**Data model (first cut):**
- `teams` (id, name, owner)
- `members` (team_id, user_id, role)
- `workspaces` (id, team_id, name)
- `states` (id, workspace_id, hash, repos jsonb, created_by, created_at, blessed bool)
- `tokens` (hashed API tokens → team/user, for CLI auth)

**API endpoints (Edge Functions):**
- `POST /states` — push a state `{workspace, hash, repos}` (auth required)
- `POST /states/:hash/bless` — mark a state as the team's blessed state
- `GET /states/blessed?workspace=…` — pull the blessed state
- `GET /states/:hash` — registry resolve (hash → full state)
- `GET /workspaces/:id/history` — state timeline

**CLI ↔ server contract (reuses existing pure functions):**
- `push` = `buildState(manifestPath)` (already exists in `src/commands/freeze.ts`) → `POST /states`.
- `pull` = `GET /states/blessed` → `restoreState(manifestPath, state)` (already exists in `src/commands/checkout.ts`).
- `status --remote` = compare `buildState().hash` to the blessed hash.
- The pure `buildState` / `restoreState` split done in v0.2 means the CLI side is mostly wiring HTTP around functions that already exist and are tested.

**Where keys finally come in (the `.env.local` question):**
- **Server-side `.env`:** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, etc.
- **CLI-side:** `REPOLITH_TOKEN` (team API token) + `REPOLITH_SERVER_URL`. Read from env or `~/.repolith` config. ⚠️ The **published CLI runs under Node, which does NOT auto-load `.env.local`** (that's a `bun run` convenience). When wiring this, add explicit env loading or a config file — don't assume `.env.local` is read by the shipped binary.

---

## Build phases (ship the smallest valuable slice first)

1. **MVP registry** — Supabase `states` table + `push`/`pull` Edge Functions + CLI `login`/`push`/`pull` + token auth. Validates the entire wedge with the least code. *(Reuses `buildState`/`restoreState`.)*
2. **Bless + drift** — blessed-state concept + `status --remote` drift indicator.
3. **Notifications** — Slack/webhook on blessed-hash change.
4. **Dashboard** — Vercel + React: workspace state, history, members.
5. **Billing** — per-seat (Stripe). Free tier: registry/resolve. Paid: team sync + drift + dashboard + notifications.

---

## Monetization

- **Free forever:** CLI + MCP server + VS Code extension. (Distribution; never gate these.)
- **Paid:** the server — team sync, drift detection, registry, dashboard, alerts. ~$X/seat/mo.
- **Conversion logic:** the free CLI *creates* the problem (a team now shares a lockfile) that the paid server *solves* (one blessed source of truth). That's the healthy open-core shape — not "free thing crippled, pay to uncripple."

---

## Open decisions (resolve before/while building)

- **SaaS vs self-host vs both?** Likely OSS server + a hosted option (devs trust self-hostable infra).
- **Auth granularity:** per-user tokens vs per-team service tokens.
- **Free vs paid line:** is the hash→state *registry* free (adoption driver) while *team sync/bless* is paid?
- **Pricing tiers.**
- **Is this a feature of repolith or a separate product/repo?** (Recommend a separate repo; the CLI stays lean and keyless.)

## Risks / honest cautions

- This is a **different company than a CLI** — infra reliability, billing, support, uptime. Don't underestimate the step change.
- **Do not build ahead of demand.** Wait until the free CLI has users and someone asks "how do we share this across the team." Build the thing people are pulling for.
- Keep the **CLI keyless and frictionless** — the server is *opt-in*. The day `repolith sync` requires a login is the day adoption stalls.
- Verify every vendor surface live at build time (Supabase API shapes, Edge Function runtime, Stripe, MCP) — committed plans (including this one) are hypotheses, not authority (rule #1).

---

## Optional things we can do (smaller, independent — pick any, any order)

These are not the server; they're quick wins / polish that stand alone:

1. **GitHub enrichment in `status`** (optional `GITHUB_TOKEN`) — also show open PRs / CI state per repo; degrades gracefully without a token. *The single most useful key-feature, and the one place `.env.local` would pay off soonest.*
2. **Republish the VS Code extension as `0.1.1`** so the new icon shows on the Marketplace (icon is wired in `vscode-extension/package.json`; just needs `vsce publish` again).
3. **GitHub Actions CI** — `.github/workflows/ci.yml` running `bun test` on push/PR → a green build badge for the README.
4. **Logo variants** (all from `assets/logo.svg` via `scripts/render-logo.mjs`) — horizontal wordmark/banner, GitHub **social-preview card** (1280×640), favicon, monochrome, or a recolor.
5. **`repolith summary`** — LLM digest of cross-repo changes (`ANTHROPIC_API_KEY`). Lower priority: the **MCP server already lets an agent do this** without baking a key into the CLI.
6. **Docs polish toward 1.0** — `CHANGELOG.md`, `CONTRIBUTING.md`, a docs site / examples directory, more edge-case tests.
7. **Dogfood on a real Bun stack** — point `repolith.toml` at 2–3 of your actual repos and shake out rough edges (this is how we found the `grep` flag bug). Highest learning-per-effort.
8. **`--json` on the write commands** too (sync/checkout/freeze/open) for fully machine-readable CI output.

> Recommended order if unsure: **#7 (dogfood) → #2 (icon live) → #3 (CI) → #1 (GitHub enrichment)** — cheap, high-value, and they harden the free tool before the server conversation.
