#!/usr/bin/env node
import { Command } from 'commander';

const program = new Command();
program
  .name('repolith')
  .description('Make a set of independent git repos feel like one monorepo')
  .version('0.0.1');

program.parse();
