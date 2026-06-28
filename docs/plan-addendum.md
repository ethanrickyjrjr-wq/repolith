
## Additional Tasks — repolith status, repolith exec, repolith init

### Why these were missing
repolith status is the most-used daily command — gita's entire reason to exist is the color-coded status table.
repolith exec is the power-user escape hatch — meta's core feature: run any command in all repos.
repolith init removes manual TOML writing — it is the on-ramp.

---

### Update to Task 4 (src/git.ts)
Add gitStatusRaw() to the git wrapper. Uses git status --porcelain=v2 --branch for
machine-readable output including branch name, ahead/behind counts, dirty files, untracked count.

Also add RepoStatus to src/types.ts:
  export interface RepoStatus {
    name: string; path: string; branch: string;
    ahead: number; behind: number; dirty: boolean; untracked: number;
  }

---

### Task A: repolith status

Files: src/format.ts, src/commands/status.ts, src/cli.ts

Produces: color-coded table REPO | BRANCH | AHEAD | BEHIND | DIRTY | UNTRACKED

Key implementation points:
- format.ts exports statusTable(rows) -- uses ANSI escape codes for color
- GREEN branch name, YELLOW for non-zero ahead/behind/untracked, RED for dirty
- status.ts calls gitStatusRaw() via runAll(), passes to statusTable(), prints
- Error repos show in RED with the error message

Smoke test: bun run dev status --manifest workspace.toml
Commit message: feat: repolith status -- color-coded repo table

---

### Task B: repolith exec

Files: src/commands/exec.ts, src/cli.ts

Usage: repolith exec "npm install" --manifest workspace.toml
Runs any shell command in each repo dir (cwd = repo path).
Prefixes every stdout/stderr line with [repo-name].
Exits 1 if any repo command exits non-zero.

Key implementation points:
- Use execa with shell: true so pipes, &&, etc. work
- Capture stdout + stderr per repo (reject: false so we handle errors ourselves)
- runAll for parallel execution with the standard concurrency cap

Smoke tests:
  bun run dev exec "git log --oneline -1" --manifest workspace.toml
  bun run dev exec "npm install" --manifest workspace.toml

Commit message: feat: repolith exec -- shell command dispatch across all repos

---

### Task C: repolith init

Files: src/commands/init.ts, src/cli.ts

Interactive TOML creator. Prompts for:
  1. Workspace name (default: my-workspace)
  2. Repos one at a time: name / url / local path (default: repos/NAME) / branch (default: main)
  3. Blank name = done

Writes workspace.toml. Exits with error if file exists and --force not passed.

After writing, prints: "Run: repolith sync" as next step.

Commit message: feat: repolith init -- interactive manifest creator
