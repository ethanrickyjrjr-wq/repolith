# Changelog

## 0.4.0 — 2026-08-30

### Added — agent coordination layer

repolith now coordinates parallel AI coding sessions working in the same workspace.

- **Plan-time conflict catch.** A `PreToolUse` hook on `ExitPlanMode` registers each session's plan and its blast radius, compares it against every other active session, and injects the overlap report into the session's context *before it edits*. Spec/plan files saved to disk are registered the same way (`spec-hook`), so sessions that declare scope in markdown are covered too.
- **Edit gate.** The first session to touch a file claims it; another live session's `Edit`/`Write` of the same file is denied with the holder named and a runnable recovery command. Claims release on commit (`--post-commit`), on explicit release, on a verified-stale check against git, or on TTL.
- **Bash backstop.** `sed -i`, `git checkout`, codegen — anything that changes files without an `Edit` payload — is fingerprinted before/after the command and claimed after the fact.
- **Auto-resume with FIFO fairness.** `repolith claim wait` blocks until the holder releases and acquires the instant it does; the wait graph (`claim waits`) surfaces mutual waits as deadlocks instead of hangs.
- **Journal + read-before-touch.** Short notes keyed by file, auto-derived from commits/claims/plans, are shown to a session the moment it first touches a file another session has been working on. A `SessionStart` catch-up brief summarises in-flight work on resume.
- **Liveness + staleness.** Per-session heartbeats separate "working elsewhere" from "crashed"; stale claims are released only on git evidence (file clean, holder already committed).
- **Operator override with revocation.** Releasing a held file to unblock one session bars the booted session from silently re-taking it.
- **New CLI:** `hooks install`, `plan list|clear|declare`, `claim list|release|wait|waits`.
- **New MCP tools:** `repolith_register_plan`, `repolith_compare_plans`, `repolith_list_active`, `repolith_claim`, `repolith_check`, `repolith_release`, `repolith_list_claims`, `repolith_wait_claim`.
- **Cross-session text is sanitized** at every context-injection sink.

### Added — MCP guardrails

- `repolith mcp` now requires `--agent-id`; `repolith_checkout` is only registered for an agent-id with `checkout = true` in `repolith.grants.toml` (`--grants`). No grants file = read-only. Replaces `--allow-write`.
- Every MCP tool call — workspace and coordination, success or failure — is appended to a hash-chained `repolith.audit.jsonl` (`--audit`), verifiable through the always-on `repolith_audit` tool.

### Changed

- **Breaking (MCP):** `--allow-write` is gone; use `--agent-id` + a grants file.

- README leads with coordination; multi-repo composition is the supporting layer.

### Known limitations

- Cooperative only — coordination works through the client's hook surface, and only Claude Code hooks are wired today.
- Same-machine store (`<workspace>/.repolith/`). Cross-machine coordination is not in this release.
- Claim keys are path-based: a rename/move is a new file.

## 0.3.x

CLI (`sync`, `checkout`, `status`, `grep`, `log`, `diff`, `exec`, `init`, `bisect`, `state`, `freeze`, `open`), lockfile with atomic workspace hash, MCP server, VS Code extension.
