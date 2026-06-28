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

function fail(e: Error): never {
  console.error(e.message);
  process.exit(1);
}

const program = new Command();
program
  .name('repolith')
  .description('Make a set of independent git repos feel like one monorepo')
  .version('0.3.0');

program
  .command('sync')
  .description('Clone missing repos, update all to their tracked refs, and write the lockfile')
  .argument('[manifest]', 'Path to repolith.toml', 'repolith.toml')
  .action(async (manifest: string) => {
    await syncCommand(manifest).catch(fail);
  });

program
  .command('checkout')
  .description('Restore every repo to the commit pinned in repolith.lock.json (deterministic system restore)')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (opts: { manifest: string }) => {
    await checkoutCommand(opts.manifest).catch(fail);
  });

program
  .command('state')
  .description('Print the atomic workspace hash + each repo\'s current commit')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .option('--json', 'Output structured JSON', false)
  .action(async (opts: { manifest: string; json?: boolean }) => {
    await stateCommand(opts.manifest, opts.json ?? false).catch(fail);
  });

program
  .command('freeze')
  .description('Write a shareable snapshot of the current state to a file')
  .argument('[outfile]', 'Output path', 'repolith.state.json')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (outfile: string, opts: { manifest: string }) => {
    await freezeCommand(opts.manifest, outfile).catch(fail);
  });

program
  .command('open')
  .description('Reconstruct the workspace from a shared state file (from `repolith freeze`)')
  .argument('<statefile>', 'Path to a repolith.state.json')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (statefile: string, opts: { manifest: string }) => {
    await openCommand(opts.manifest, statefile).catch(fail);
  });

program
  .command('status')
  .description('Show branch + dirty/clean + ahead/behind for every repo')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .option('--json', 'Output structured JSON', false)
  .action(async (opts: { manifest: string; json?: boolean }) => {
    await statusCommand(opts.manifest, opts.json ?? false).catch(fail);
  });

program
  .command('exec')
  .description('Run a shell command in every repo (quote the command)')
  .argument('<command>', 'Command to run, e.g. "npm test"')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (command: string, opts: { manifest: string }) => {
    await execCommand(command, opts.manifest).catch(fail);
  });

program
  .command('grep')
  .description('Search across all repos (uses git grep)')
  .argument('<pattern>', 'Search pattern')
  .option('-i, --ignore-case', 'Case-insensitive match')
  .option('-l, --files-with-matches', 'Print only filenames')
  .option('-w, --word-regexp', 'Match whole words only')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .option('--json', 'Output structured JSON', false)
  .allowUnknownOption()
  .action(async (
    pattern: string,
    opts: { ignoreCase?: boolean; filesWithMatches?: boolean; wordRegexp?: boolean; manifest: string; json?: boolean },
  ) => {
    const extra: string[] = [];
    if (opts.ignoreCase) extra.push('-i');
    if (opts.filesWithMatches) extra.push('-l');
    if (opts.wordRegexp) extra.push('-w');
    await grepCommand(pattern, extra, opts.manifest, opts.json ?? false).catch(fail);
  });

program
  .command('log')
  .description('Show git log for all repos')
  .option('-n, --max-count <n>', 'Limit number of commits', '10')
  .option('--since <date>', 'Show commits more recent than date')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .option('--json', 'Output structured JSON', false)
  .action(async (opts: { maxCount: string; since?: string; manifest: string; json?: boolean }) => {
    const extra = ['-n', opts.maxCount];
    if (opts.since) extra.push(`--since=${opts.since}`);
    await logCommand(extra, opts.manifest, opts.json ?? false).catch(fail);
  });

program
  .command('diff')
  .description('Show git diff across all repos')
  .option('--staged', 'Show staged changes')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .option('--json', 'Output structured JSON', false)
  .allowUnknownOption()
  .action(async (opts: { staged?: boolean; manifest: string; json?: boolean }) => {
    const extra: string[] = [];
    if (opts.staged) extra.push('--staged');
    await diffCommand(extra, opts.manifest, opts.json ?? false).catch(fail);
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
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (opts: { good: string; test: string; manifest: string }) => {
    const res = await bisect({ manifestPath: opts.manifest, goodLockPath: opts.good, test: opts.test }).catch(fail);
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

program
  .command('mcp')
  .description('Run repolith as an MCP server (stdio) so AI agents can query and restore workspace state')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .option('--allow-write', 'Expose mutating tools (repolith_checkout); off by default', false)
  .action(async (opts: { manifest: string; allowWrite?: boolean }) => {
    await startMcpServer(opts.manifest, { allowWrite: opts.allowWrite ?? false }).catch(fail);
  });

program.parse();
