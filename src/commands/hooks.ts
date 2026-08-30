// `hooks install` — wire the coordination hooks into a workspace with one command.
//
// Writes four PreToolUse hooks (ExitPlanMode→plan-hook, Edit/Write→edit-hook,
// Bash→bash-pre-hook), three PostToolUse hooks (Bash→bash-post-hook — the P1.5
// Bash-bypass backstop: bash-pre-hook snapshots the dirty-file baseline,
// bash-post-hook diffs it and claims whatever the command changed — plus
// Edit/Write→spec-hook, the T2 spec-file → plan-store bridge), and one
// SessionStart hook (→session-hook, catch-up brief on start/resume) into
// <root>/.claude/settings.json — merged into any existing settings, idempotent.
// With --post-commit it also drops the per-repo auto-release hook. Every command
// it writes uses selfInvocation(), so a from-source dogfood run gets
// `bun run …/src/cli.ts …` and an installed run gets `repolith …`.
//
// Verified live 2026-06-28: Claude Code (headless `claude -p`) honors hooks from
// an auto-discovered <root>/.claude/settings.json, so writing there is enough.
// PostToolUse Bash matcher + payload shape verified live 2026-06-30 against
// docs.claude.com/hooks (matcher accepts a plain tool name like "Bash";
// PostToolUse can't set permissionDecision, only additionalContext — expected,
// since the command has already run by the time it fires).

import { readFile, writeFile, mkdir, stat, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseManifest } from '../manifest.js';
import { selfInvocation } from '../coord/invocation.js';

interface CommandHook {
  type: 'command';
  command: string;
  timeout?: number;
}
interface HookEntry {
  matcher: string;
  hooks: CommandHook[];
}
interface MatcherSpec {
  matcher: string;
  sub: 'plan-hook' | 'edit-hook' | 'bash-pre-hook' | 'bash-post-hook' | 'spec-hook';
  timeout: number;
}

const PRE_MATCHERS: MatcherSpec[] = [
  { matcher: 'ExitPlanMode', sub: 'plan-hook', timeout: 20 },
  { matcher: 'Edit', sub: 'edit-hook', timeout: 15 },
  { matcher: 'Write', sub: 'edit-hook', timeout: 15 },
  { matcher: 'Bash', sub: 'bash-pre-hook', timeout: 10 },
];
const POST_MATCHERS: MatcherSpec[] = [
  { matcher: 'Bash', sub: 'bash-post-hook', timeout: 15 },
  // T2 spec-file bridge: a saved spec/plan .md registers the session's blast radius.
  { matcher: 'Edit', sub: 'spec-hook', timeout: 15 },
  { matcher: 'Write', sub: 'spec-hook', timeout: 15 },
];

const buildEntry = (cmd: string, { matcher, sub, timeout }: MatcherSpec): HookEntry => ({
  matcher,
  hooks: [{ type: 'command', command: `${cmd} ${sub}`, timeout }],
});

/** The four PreToolUse entries repolith installs, with commands prefixed by `cmd`. */
export function buildHookEntries(cmd: string): HookEntry[] {
  return PRE_MATCHERS.map((m) => buildEntry(cmd, m));
}

/** The PostToolUse entries repolith installs (P1.5 Bash-bypass claim + T2 spec bridge). */
export function buildPostHookEntries(cmd: string): HookEntry[] {
  return POST_MATCHERS.map((m) => buildEntry(cmd, m));
}

/** The SessionStart catch-up brief entry (fires on all sources: startup, resume, clear, compact). */
export function buildSessionEntry(cmd: string): HookEntry {
  return { matcher: '*', hooks: [{ type: 'command', command: `${cmd} session-hook`, timeout: 10 }] };
}

/** Merge one event's (PreToolUse/PostToolUse) matcher specs into its existing entry list.
 *  Idempotent: an entry is skipped when one already matches the same matcher and references
 *  the same subcommand. Returns the merged list and a human list of what was added. */
function mergeHookList(existing: HookEntry[], cmd: string, specs: MatcherSpec[]): { list: HookEntry[]; added: string[] } {
  const list = [...existing];
  const added: string[] = [];
  for (const spec of specs) {
    const entry = buildEntry(cmd, spec);
    const present = list.some(
      (e) =>
        e.matcher === entry.matcher &&
        Array.isArray(e.hooks) &&
        e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes(spec.sub)),
    );
    if (!present) {
      list.push(entry);
      added.push(`${entry.matcher} → ${entry.hooks[0].command}`);
    }
  }
  return { list, added };
}

/**
 * Merge repolith's hooks into an existing settings object without disturbing
 * anything else. Idempotent — see mergeHookList. Returns the new settings and
 * a human list of what was added.
 */
export function mergeSettings(
  existing: Record<string, unknown>,
  cmd: string,
): { settings: Record<string, unknown>; added: string[] } {
  const settings: Record<string, unknown> = { ...existing };
  const hooks: Record<string, unknown> = { ...((settings.hooks as Record<string, unknown>) ?? {}) };
  const added: string[] = [];

  const pre = mergeHookList(Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as HookEntry[]) : [], cmd, PRE_MATCHERS);
  hooks.PreToolUse = pre.list;
  added.push(...pre.added);

  const post = mergeHookList(Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as HookEntry[]) : [], cmd, POST_MATCHERS);
  hooks.PostToolUse = post.list;
  added.push(...post.added);

  // SessionStart — catch-up brief on session start/resume
  const sess: HookEntry[] = Array.isArray(hooks.SessionStart) ? [...(hooks.SessionStart as HookEntry[])] : [];
  const sessionPresent = sess.some(
    (e) => Array.isArray(e.hooks) && e.hooks.some((h) => typeof h?.command === 'string' && h.command.includes('session-hook')),
  );
  if (!sessionPresent) {
    const se = buildSessionEntry(cmd);
    sess.push(se);
    added.push(`SessionStart → ${se.hooks[0].command}`);
  }
  hooks.SessionStart = sess;

  settings.hooks = hooks;
  return { settings, added };
}

/**
 * If the workspace root is itself a git repo, make sure the coordination store can
 * never be committed (review finding 9): `.repolith/` leaked into a tracked repo
 * exactly this way once, and the current safety is pure topology (the deployed
 * workspace root happens not to be a repo). Appends `.repolith/` to the root
 * `.gitignore`, creating it if missing; idempotent. Returns the .gitignore path
 * when a write happened (or would happen, for --print), null otherwise.
 */
export async function ensureStoreIgnored(root: string, print?: boolean): Promise<string | null> {
  try {
    await stat(join(root, '.git')); // dir for a normal repo, FILE for a worktree — both count
  } catch {
    return null; // root isn't a repo — nothing can track .repolith/ from here
  }
  const giPath = join(root, '.gitignore');
  let cur = '';
  try {
    cur = await readFile(giPath, 'utf8');
  } catch {
    /* no .gitignore yet — create it */
  }
  const present = cur
    .split(/\r?\n/)
    .map((l) => l.trim())
    .some((l) => l === '.repolith' || l === '.repolith/' || l === '/.repolith' || l === '/.repolith/');
  if (present) return null;
  if (!print) {
    const next = (cur ? (cur.endsWith('\n') ? cur : cur + '\n') : '') + '.repolith/\n';
    await writeFile(giPath, next, 'utf8');
  }
  return giPath;
}

export interface HooksInstallOpts {
  manifest: string;
  postCommit?: boolean;
  local?: boolean;
  print?: boolean;
}

export async function hooksInstall(opts: HooksInstallOpts): Promise<void> {
  const manifestPath = resolve(opts.manifest);
  const root = dirname(manifestPath);
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const cmd = selfInvocation();

  const settingsPath = join(root, '.claude', opts.local ? 'settings.local.json' : 'settings.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, 'utf8')) as Record<string, unknown>;
  } catch {
    /* no settings file yet — start fresh */
  }
  const { settings, added } = mergeSettings(existing, cmd);
  const body = JSON.stringify(settings, null, 2) + '\n';

  if (opts.print) {
    console.log(`# would write ${settingsPath}\n${body}`);
  } else {
    await mkdir(dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, body, 'utf8');
    console.log(
      added.length
        ? `Wrote ${added.length} hook(s) to ${settingsPath}:`
        : `${settingsPath} already had the repolith hooks — no change.`,
    );
    for (const a of added) console.log(`  + ${a}`);
  }
  console.log(`Hook command prefix: ${cmd}`);

  const gi = await ensureStoreIgnored(root, opts.print);
  if (gi) console.log(opts.print ? `# would add .repolith/ to ${gi}` : `+ added .repolith/ to ${gi} (workspace root is a git repo — the coord store must never be committed)`);

  if (opts.postCommit) {
    console.log(opts.print ? 'post-commit (dry run):' : 'post-commit auto-release:');
    for (const repo of manifest.repos) {
      await installPostCommit(resolve(root, repo.path), cmd, opts.print);
    }
  } else {
    console.log(`Tip: add --post-commit to also install the per-repo auto-release hook.`);
  }
}

/** Create <repo>/.git/hooks/post-commit running `<cmd> claim release --committed`. Never clobbers an existing hook. */
async function installPostCommit(repoDir: string, cmd: string, print?: boolean): Promise<void> {
  const line = `${cmd} claim release --committed`;
  const gitPath = join(repoDir, '.git');
  let gitStat;
  try {
    gitStat = await stat(gitPath);
  } catch {
    console.log(`  ! ${repoDir}: no .git — skipped`);
    return;
  }
  if (!gitStat.isDirectory()) {
    console.log(`  ! ${repoDir}: .git is not a directory (worktree/submodule) — add manually: ${line}`);
    return;
  }

  const hookPath = join(repoDir, '.git', 'hooks', 'post-commit');
  let current: string | null = null;
  try {
    current = await readFile(hookPath, 'utf8');
  } catch {
    /* none yet */
  }
  if (current && current.includes('claim release --committed')) {
    console.log(`  = ${hookPath}: already releases on commit`);
    return;
  }
  if (current) {
    // Don't mutate someone else's hook (it may `exit` early or do unrelated work).
    console.log(`  ! ${hookPath} exists — add this line yourself:\n      ${line}`);
    return;
  }
  if (print) {
    console.log(`  # would create ${hookPath}: #!/bin/sh + \`${line}\``);
    return;
  }
  await mkdir(dirname(hookPath), { recursive: true });
  await writeFile(hookPath, `#!/bin/sh\n${line}\n`, 'utf8');
  await chmod(hookPath, 0o755).catch(() => {});
  console.log(`  + ${hookPath}`);
}
