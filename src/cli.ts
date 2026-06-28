#!/usr/bin/env node
import { Command } from 'commander';
import { syncCommand } from './commands/sync.js';
import { statusCommand } from './commands/status.js';
import { execCommand } from './commands/exec.js';
import { grepCommand } from './commands/grep.js';
import { logCommand } from './commands/log.js';
import { diffCommand } from './commands/diff.js';
import { initCommand } from './commands/init.js';

function fail(e: Error): never {
  console.error(e.message);
  process.exit(1);
}

const program = new Command();
program
  .name('repolith')
  .description('Make a set of independent git repos feel like one monorepo')
  .version('0.0.1');

program
  .command('sync')
  .description('Clone missing repos, update all to their tracked refs, and write the lockfile')
  .argument('[manifest]', 'Path to repolith.toml', 'repolith.toml')
  .action(async (manifest: string) => {
    await syncCommand(manifest).catch(fail);
  });

program
  .command('status')
  .description('Show branch + dirty/clean + ahead/behind for every repo')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (opts: { manifest: string }) => {
    await statusCommand(opts.manifest).catch(fail);
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
  .allowUnknownOption()
  .action(async (
    pattern: string,
    opts: { ignoreCase?: boolean; filesWithMatches?: boolean; wordRegexp?: boolean; manifest: string },
  ) => {
    const extra: string[] = [];
    if (opts.ignoreCase) extra.push('-i');
    if (opts.filesWithMatches) extra.push('-l');
    if (opts.wordRegexp) extra.push('-w');
    await grepCommand(pattern, extra, opts.manifest).catch(fail);
  });

program
  .command('log')
  .description('Show git log for all repos')
  .option('-n, --max-count <n>', 'Limit number of commits', '10')
  .option('--since <date>', 'Show commits more recent than date')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .action(async (opts: { maxCount: string; since?: string; manifest: string }) => {
    const extra = ['-n', opts.maxCount];
    if (opts.since) extra.push(`--since=${opts.since}`);
    await logCommand(extra, opts.manifest).catch(fail);
  });

program
  .command('diff')
  .description('Show git diff across all repos')
  .option('--staged', 'Show staged changes')
  .option('--manifest <path>', 'Path to repolith.toml', 'repolith.toml')
  .allowUnknownOption()
  .action(async (opts: { staged?: boolean; manifest: string }) => {
    const extra: string[] = [];
    if (opts.staged) extra.push('--staged');
    await diffCommand(extra, opts.manifest).catch(fail);
  });

program
  .command('init')
  .description('Interactively create a repolith.toml')
  .option('-d, --dir <path>', 'Directory to create repolith.toml in', '.')
  .option('-f, --force', 'Overwrite an existing repolith.toml')
  .action(async (opts: { dir: string; force?: boolean }) => {
    await initCommand(opts.dir, opts.force ?? false).catch(fail);
  });

program.parse();
