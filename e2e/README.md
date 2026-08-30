# coord e2e — §4 Interactive Multi-Agent Run

The gate for the coordination feature. Two (or three) real Claude sessions work on overlapping tasks in a shared repo while repolith hooks fire transparently.

## What you're testing

| Item | What to watch for |
|---|---|
| **Plan-time catch** | Agent B's plan phase shows a conflict warning in its context (additionalContext from plan-hook). Does it adapt before editing? |
| **Fairness** | With 3 sessions contending the same file, do they acquire in arrival order? |
| **Agent self-recovery** | After a deny, does the session run `claim wait` and retry — or just stop? |
| **Scope-creep flag** | Does the advisory nudge help or annoy? Does the agent consult its advisor on it, or ignore it? |

## First run

```
# 1. Create the workspace (once)
bun run e2e/setup.ts

# 2. Open 3 terminals
```

**Terminal 1 — Agent A**
```
cd <path-to>/repolith-e2e
claude
```
Paste `e2e/prompts/agent-a.md` as the opening message.

**Terminal 2 — Agent B** (start within ~30s of A — while A is still in plan mode, so both plans register before either starts editing)
```
cd <path-to>/repolith-e2e
claude
```
Paste `e2e/prompts/agent-b.md` as the opening message.

**Terminal 3 — Observer** (keep this open the whole time)
```
bun run e2e/observe.ts
```
Live view of plans, claims, waits, and journal entries. Refreshes every 2s.

**Optional Terminal 4 — Agent C**
```
cd <path-to>/repolith-e2e
claude
```
Paste `e2e/prompts/agent-c.md`. Adds a third session for README docs — contends on `src/types.ts` with A and B.

## Re-running

```
bun run e2e/reset.ts
```

Wipes `.repolith/` (plans/claims/waits/journal) and `git reset --hard HEAD` to restore source files. Hooks stay installed. Then re-open agents.

## What the hooks do (agent doesn't see this)

**SessionStart hook** (`session-hook`):
- On startup/resume: if other sessions are active or files are claimed, injects a catch-up brief (who's working on what, which files are held)
- Silent on a quiet workspace — no nag when nothing is in flight

**ExitPlanMode hook** (`plan-hook`):
- Registers the session's plan (summary + declared areas) in `.repolith/sessions/`
- Writes a journal note for each concrete-file area so later sessions see the intent
- Compares against other active sessions
- If overlap: injects a conflict warning into `additionalContext` of the approving plan UI

**Edit/Write hook** (`edit-hook`):
- First touch of a file: claims it for this session + writes a `claim` journal note
- Second session tries to edit the same file: **deny** + tells them to run `claim wait`
- After claiming: injects a brief (others' recent notes ≤48h on this file + scope-creep flag if outside declared areas)

**Post-commit hook**:
- Releases claims on committed files
- Writes a journal note (commit subject + SHA) so the next session sees what changed

## Diagnosing issues

```
# See what's in the store right now (from within the workspace)
repolith plan list
repolith claim list
repolith claim waits

# Force-clear a stuck session
repolith plan clear <session-id>
repolith claim release --session <session-id>
```

## The hot files (expected contention points)

Both Agent A and Agent B will try to edit:
- `src/types.ts` — A adds `LoginResult`, B adds `RateLimitConfig`
- `src/index.ts` — both add exports

Whoever edits first holds the claim. The second session gets denied + blocked until the first commits.
