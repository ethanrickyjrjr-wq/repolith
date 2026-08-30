#!/usr/bin/env node
import { Command } from 'commander';
import { syncCommand } from './commands/sync.js';
import { checkoutCommand } from './commands/checkout.js';
import { statusCommand } from './commands/status.js';
import { execCommand } from './commands/exec.js';
import { grepCommand } from './commands/grep.js';
import { logCommand } from './commands/log.js';
import { diffCommand } from './commands/diff.js';
import { initCommand } from './commands/init.js';
import { startMcpServer } from './mcp.js';
import { bisect } from './commands/bisect.js';
import { freezeCommand, stateCommand } from './commands/freeze.js';
import { openCommand } from './commands/open.js';
import { planHook, planList, planClear } from './commands/plan.js';
import { specHook, planDeclare } from './commands/spec.js';
import { editHook, claimList, claimRelease, claimWait, claimWaits } from './commands/claim.js';
import { sessionHook } from './commands/session.js';
import { bashPreHook, bashPostHook } from './commands/bash.js';
import { hooksInstall } from './commands/hooks.js';
import { resolveManifest } from './locate.js';

function fail(e: Error): never {
  console.error(e.message);
  process.exit(1);
}

// Resolve the manifest the same way the hooks do — walk up from the current
// directory to the nearest repolith.toml (or honor an explicit --manifest that
// exists) — then run the command with that absolute path. Every command derives
// its workspace root from the manifest path, so resolving here means `repolith`
// works from any repo inside the workspace, not only from the workspace root,
// and a missing/typo'd manifest fails loudly instead of silently operating on
// the wrong (or an empty) directory. See src/locate.ts for why the stat matters.
async function withManifest(
  explicit: string | undefined,
  run: (manifestPath: string) => Promise<unknown>,
): Promise<void> {
  try {
    const manifestPath = await resolveManifest(explicit);
    await run(manifestPath);
  } catch (e) {
    fail(e as Error);
  }
}

const MANIFEST_DESC = 'Path to repolith.toml (default: nearest one found walking up from the current directory)';

const program = new Command();
program
  .name('repolith')
  .description('Make a set of independent git repos feel like one monorepo')
  .version('0.4.0');

program
  .command('sync')
  .description('Clone missing repos, update all to their tracked refs, and write the lockfile')
  .argument('[manifest]', MANIFEST_DESC)
  .action(async (manifest?: string) => {
    await withManifest(manifest, (mp) => syncCommand(mp));
  });

program
  .command('checkout')
  .description('Restore every repo to the commit pinned in repolith.lock.json (deterministic system restore)')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (opts: { manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => checkoutCommand(mp));
  });

program
  .command('state')
  .description('Print the atomic workspace hash + each repo\'s current commit')
  .option('--manifest <path>', MANIFEST_DESC)
  .option('--json', 'Output structured JSON', false)
  .action(async (opts: { manifest?: string; json?: boolean }) => {
    await withManifest(opts.manifest, (mp) => stateCommand(mp, opts.json ?? false));
  });

program
  .command('freeze')
  .description('Write a shareable snapshot of the current state to a file')
  .argument('[outfile]', 'Output path', 'repolith.state.json')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (outfile: string, opts: { manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => freezeCommand(mp, outfile));
  });

program
  .command('open')
  .description('Reconstruct the workspace from a shared state file (from `repolith freeze`)')
  .argument('<statefile>', 'Path to a repolith.state.json')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (statefile: string, opts: { manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => openCommand(mp, statefile));
  });

program
  .command('status')
  .description('Show branch + dirty/clean + ahead/behind for every repo')
  .option('--manifest <path>', MANIFEST_DESC)
  .option('--json', 'Output structured JSON', false)
  .action(async (opts: { manifest?: string; json?: boolean }) => {
    await withManifest(opts.manifest, (mp) => statusCommand(mp, opts.json ?? false));
  });

program
  .command('exec')
  .description('Run a shell command in every repo (quote the command)')
  .argument('<command>', 'Command to run, e.g. "npm test"')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (command: string, opts: { manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => execCommand(command, mp));
  });

program
  .command('grep')
  .description('Search across all repos (uses git grep)')
  .argument('<pattern>', 'Search pattern')
  .option('-i, --ignore-case', 'Case-insensitive match')
  .option('-l, --files-with-matches', 'Print only filenames')
  .option('-w, --word-regexp', 'Match whole words only')
  .option('--manifest <path>', MANIFEST_DESC)
  .option('--json', 'Output structured JSON', false)
  .allowUnknownOption()
  .action(async (
    pattern: string,
    opts: { ignoreCase?: boolean; filesWithMatches?: boolean; wordRegexp?: boolean; manifest?: string; json?: boolean },
  ) => {
    const extra: string[] = [];
    if (opts.ignoreCase) extra.push('-i');
    if (opts.filesWithMatches) extra.push('-l');
    if (opts.wordRegexp) extra.push('-w');
    await withManifest(opts.manifest, (mp) => grepCommand(pattern, extra, mp, opts.json ?? false));
  });

program
  .command('log')
  .description('Show git log for all repos')
  .option('-n, --max-count <n>', 'Limit number of commits', '10')
  .option('--since <date>', 'Show commits more recent than date')
  .option('--manifest <path>', MANIFEST_DESC)
  .option('--json', 'Output structured JSON', false)
  .action(async (opts: { maxCount: string; since?: string; manifest?: string; json?: boolean }) => {
    const extra = ['-n', opts.maxCount];
    if (opts.since) extra.push(`--since=${opts.since}`);
    await withManifest(opts.manifest, (mp) => logCommand(extra, mp, opts.json ?? false));
  });

program
  .command('diff')
  .description('Show git diff across all repos')
  .option('--staged', 'Show staged changes')
  .option('--manifest <path>', MANIFEST_DESC)
  .option('--json', 'Output structured JSON', false)
  .allowUnknownOption()
  .action(async (opts: { staged?: boolean; manifest?: string; json?: boolean }) => {
    const extra: string[] = [];
    if (opts.staged) extra.push('--staged');
    await withManifest(opts.manifest, (mp) => diffCommand(extra, mp, opts.json ?? false));
  });

program
  .command('init')
  .description('Interactively create a repolith.toml')
  .option('-d, --dir <path>', 'Directory to create repolith.toml in', '.')
  .option('-f, --force', 'Overwrite an existing repolith.toml')
  .action(async (opts: { dir: string; force?: boolean }) => {
    await initCommand(opts.dir, opts.force ?? false).catch(fail);
  });

program
  .command('bisect')
  .description('Find the repo+commit across the whole workspace that made --test start failing')
  .requiredOption('--good <lockfile>', 'Path to a known-good repolith.lock.json')
  .requiredOption('--test <cmd>', 'Test command run at the workspace root; exit 0 = good, non-zero = bad')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (opts: { good: string; test: string; manifest?: string }) => {
    await withManifest(opts.manifest, async (mp) => {
      const res = await bisect({ manifestPath: mp, goodLockPath: opts.good, test: opts.test });
      if (!res.culprit) {
        console.log('No candidate commits between the good state and current — nothing to bisect.');
        return;
      }
      const c = res.culprit;
      console.log(`\nFirst bad commit: ${c.repo}@${c.commit.slice(0, 12)}`);
      console.log(`  ${c.subject}  —  ${c.author}, ${c.when}`);
      console.log(
        `\n(${res.steps} test runs over ${res.timelineLength} candidate commits. ` +
        `Finds *a* breaking point; assumes monotonic failure and counts build breakage as bad.)`,
      );
    });
  });

program
  .command('plan-hook')
  .description('Internal: PreToolUse/ExitPlanMode hook — register this plan and warn on overlap with other active sessions')
  .action(async () => {
    // Never break the user's plan-approval flow: any failure exits 0 silently.
    await planHook().catch(() => {});
  });

const plan = program.command('plan').description('Inspect plan-coordination sessions');
plan
  .command('list')
  .description('List active planning sessions and their declared blast radius')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (opts: { manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => planList(mp));
  });
plan
  .command('clear')
  .description('Clear (force-release) a planning session by id (also drops its file claims)')
  .argument('<id>', 'Session id to clear')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (id: string, opts: { manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => planClear(mp, id));
  });
plan
  .command('declare')
  .description('Register a spec/plan file as this session\'s blast radius and check for overlap with other active sessions')
  .argument('<file>', 'Spec/plan file to register (must match a coord.spec_patterns glob)')
  .option('--session <id>', 'Session id to register under (default: CLAUDE_SESSION_ID or declare-<pid>)')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (file: string, opts: { session?: string; manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => planDeclare(mp, file, opts));
  });

program
  .command('edit-hook')
  .description('Internal: PreToolUse Edit/Write hook — claim the touched file; deny if another active session holds it')
  .action(async () => {
    // Never break the user's edit flow: any failure exits 0 silently (no decision).
    await editHook().catch(() => {});
  });

program
  .command('spec-hook')
  .description('Internal: PostToolUse Edit/Write hook — register a saved spec/plan file as the session\'s blast radius (T2 bridge)')
  .action(async () => {
    // Never break the user's edit flow: any failure exits 0 silently.
    await specHook().catch(() => {});
  });

program
  .command('session-hook')
  .description('Internal: SessionStart hook — inject a workspace catch-up brief when coordination work is in flight')
  .action(async () => {
    await sessionHook().catch(() => {});
  });

program
  .command('bash-pre-hook')
  .description('Internal: PreToolUse Bash hook — snapshot the dirty-file baseline (Bash-bypass backstop, P1.5)')
  .action(async () => {
    await bashPreHook().catch(() => {});
  });

program
  .command('bash-post-hook')
  .description('Internal: PostToolUse Bash hook — claim files the command changed; deny-log if it collided with another session')
  .action(async () => {
    await bashPostHook().catch(() => {});
  });

const claim = program.command('claim').description('Inspect and release file claims (the edit-gate)');
claim
  .command('list')
  .description('List active file claims and which session holds each')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (opts: { manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => claimList(mp));
  });
claim
  .command('release')
  .description('Release file claims by --file, --session, --committed, or --stale (the post-commit hook uses --committed; --stale is auto-verified against git, see coord/staleness.ts)')
  .option('--file <path>', 'Release the claim on a single file')
  .option('--session <id>', 'Release all claims held by a session')
  .option('--committed', 'Release claims on the files of the latest commit (run from the repo dir)')
  .option('--stale', 'Release only claims provably stale against git (file clean + holder already committed); combine with --file to check just one claim, or run alone to sweep the whole workspace')
  .option('--include-idle', 'With --stale: also release idle-clean claims. Weaker evidence — an idle-clean file was merely never dirtied under its claim, so this can release a claim whose holder is about to make its first edit')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (opts: { file?: string; session?: string; committed?: boolean; stale?: boolean; includeIdle?: boolean; manifest?: string }) => {
    // --committed resolves its own workspace root by walking up from the repo cwd
    // (the post-commit git-hook path) and never reads the passed manifest — so
    // don't require one here, or the hook would hard-fail outside expectations.
    if (opts.committed) {
      await claimRelease('', opts).catch(fail);
      return;
    }
    await withManifest(opts.manifest, (mp) => claimRelease(mp, opts));
  });
claim
  .command('wait')
  .description('Block until a file claim is free, then acquire it (auto-resume after the holder releases)')
  .requiredOption('--file <path>', 'File to wait for')
  .requiredOption('--session <id>', 'Your session id (must match the id your edit-hook uses)')
  .option('--timeout <sec>', 'Max seconds to wait', '600')
  .option('--poll <ms>', 'Poll interval in ms', '2000')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (opts: { file: string; session?: string; timeout: string; poll: string; manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => claimWait(mp, opts));
  });
claim
  .command('waits')
  .description('Show which sessions are blocked waiting on which (the wait graph; useful for spotting deadlocks)')
  .option('--manifest <path>', MANIFEST_DESC)
  .action(async (opts: { manifest?: string }) => {
    await withManifest(opts.manifest, (mp) => claimWaits(mp));
  });

const hooks = program.command('hooks').description('Install the Claude Code coordination hooks for this workspace');
hooks
  .command('install')
  .description('Write coordination hooks into .claude/settings.json (merged, idempotent): 3 PreToolUse + 1 SessionStart; --post-commit also adds per-repo auto-release')
  .option('--manifest <path>', MANIFEST_DESC)
  .option('--post-commit', 'Also install each repo’s post-commit auto-release hook', false)
  .option('--local', 'Write .claude/settings.local.json instead of settings.json', false)
  .option('--print', 'Dry run: print what would be written, change nothing', false)
  .action(async (opts: { manifest?: string; postCommit?: boolean; local?: boolean; print?: boolean }) => {
    await withManifest(opts.manifest, (mp) => hooksInstall({ ...opts, manifest: mp }));
  });

program
  .command('mcp')
  .description('Run repolith as an MCP server (stdio) so AI agents can query and restore workspace state')
  .option('--manifest <path>', MANIFEST_DESC)
  .requiredOption('--agent-id <id>', 'Identity of the agent/session running this server; recorded on every audit log entry')
  .option('--grants <path>', 'Path to repolith.grants.toml granting this agent-id write capabilities (e.g. checkout); omit for a read-only agent')
  .option('--audit <path>', 'Path to the append-only audit log (default: repolith.audit.jsonl next to the manifest)')
  .action(async (opts: { manifest?: string; agentId: string; grants?: string; audit?: string }) => {
    await withManifest(opts.manifest, (mp) =>
      startMcpServer(mp, { agentId: opts.agentId, grantsPath: opts.grants, auditPath: opts.audit }),
    );
  });

program.parse();
