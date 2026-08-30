#!/usr/bin/env bun
// e2e/observe.ts — Live coordination state watcher for the §4 interactive run.
//
// Usage: bun run e2e/observe.ts [workspace-path]
// Default workspace: <repo>/../repolith-e2e
//
// Polls every 2s and prints: active plans, claims, waits, recent journal entries.

import { listActive } from '../src/coord/store';
import { listClaims } from '../src/coord/claims';
import { listWaits } from '../src/coord/waits';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { JournalNote } from '../src/coord/journal';

const wsArg = process.argv.slice(2).find((a) => !a.startsWith('-'));
const WORKSPACE = wsArg ? resolve(wsArg) : resolve(import.meta.dir, '..', '..', 'repolith-e2e');

function hms(iso: string): string {
  try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
}

function short(id: string, n = 24): string {
  return id.length > n ? id.slice(0, n) + '…' : id;
}

async function recentJournal(root: string, limit = 8): Promise<string[]> {
  const dir = join(root, '.repolith', 'journal');
  let files: string[];
  try { files = await readdir(dir); } catch { return []; }

  const notes: JournalNote[] = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const text = await readFile(join(dir, f), 'utf8').catch(() => '');
    for (const line of text.split('\n').filter(Boolean)) {
      try { notes.push(JSON.parse(line) as JournalNote); } catch {}
    }
  }
  notes.sort((a, b) => a.ts.localeCompare(b.ts));

  return notes.slice(-limit).map((n) =>
    `  ${hms(n.ts)}  [${n.kind}]  ${n.file}  ${n.msg ?? ''}`.slice(0, 100),
  );
}

async function tick(): Promise<void> {
  const now = Date.now();
  const [plans, claims, waits, journal] = await Promise.all([
    listActive(WORKSPACE, now),
    listClaims(WORKSPACE, now),
    listWaits(WORKSPACE, now),
    recentJournal(WORKSPACE),
  ]);

  process.stdout.write('\x1b[2J\x1b[H'); // clear screen + move to top

  const ts = new Date().toLocaleTimeString();
  console.log(`repolith coord observer  ${ts}  — ${WORKSPACE}\n`);

  // Plans
  console.log(`PLANS  (${plans.length} active)`);
  if (!plans.length) {
    console.log('  (none yet — waiting for agents to exit plan mode)');
  } else {
    for (const p of plans) {
      console.log(`  ${short(p.session_id)}  "${p.summary || '(no summary)'}"`);
      for (const a of p.areas) console.log(`    area  ${a}`);
    }
  }

  // Claims
  console.log(`\nCLAIMS  (${claims.length} active)`);
  if (!claims.length) {
    console.log('  (none yet — waiting for first edit)');
  } else {
    for (const c of claims) {
      console.log(`  ${c.file.padEnd(32)}  ←  ${short(c.session_id)}  (claimed ${hms(c.claimed_at)})`);
    }
  }

  // Waits
  console.log(`\nWAITS  (${waits.length} queued)`);
  if (!waits.length) {
    console.log('  (none — no contention yet)');
  } else {
    for (const w of waits) {
      console.log(`  ${short(w.session_id)} waits on  ${w.file}  (held by ${short(w.held_by)})`);
    }
  }

  // Journal
  console.log(`\nJOURNAL  (recent)`);
  if (!journal.length) {
    console.log('  (empty — journal fills on commit)');
  } else {
    for (const j of journal) console.log(j);
  }

  console.log('\nCtrl+C to stop — refreshing every 2s');
}

async function main(): Promise<void> {
  console.log(`Watching: ${WORKSPACE}\nStarting...\n`);
  while (true) {
    await tick().catch((e: Error) => {
      process.stdout.write('\x1b[2J\x1b[H');
      console.error(`observe error: ${e.message}`);
    });
    await new Promise((r) => setTimeout(r, 2000));
  }
}

main();
