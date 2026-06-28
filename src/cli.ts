#!/usr/bin/env node
import { Command } from 'commander';
import { syncCommand } from './commands/sync.js';

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
    await syncCommand(manifest).catch((e: Error) => {
      console.error(e.message);
      process.exit(1);
    });
  });

program.parse();
