// File-keyed coordination journal (Phase 2.5, thin slice).
//
// Sessions accumulate short, structured notes keyed to a file, AUTO-derived from
// signals they already emit (a commit, a claim, a plan) so the journal is never
// empty and nobody has to remember to write one. The edit-hook surfaces the unseen
// recent notes for a file the moment a session first touches it (read-before-touch),
// so a later session inherits what an earlier one did instead of redoing or
// clobbering it — the exact "two sessions, stale context" pain.
//
// Append-only, one JSONL file per workspace-relative path, under
// <root>/.repolith/journal/. Advisory only: never break the edit/commit flow.

import { createHash } from 'node:crypto';
import { mkdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';

// `note` is the reserved channel for genuine, inheritable content a session leaves for the
// next one (surfaced by the read-before-touch brief). `coedit` is its observability sibling:
// the Bash-bypass backstop's soft-note recording a concurrent co-edit it chose NOT to flag as
// a clobber — a non-event, brief-excluded like deny/wait/overlap/semantic (see brief.ts).
export type NoteKind = 'commit' | 'claim' | 'plan' | 'note' | 'coedit' | 'deny' | 'wait' | 'overlap' | 'semantic';

export interface JournalNote {
  file: string; // workspace-relative, forward-slashed
  kind: NoteKind;
  msg: string;
  session_id?: string; // omitted for commit notes — the git post-commit hook can't know it
  sha?: string; // commit notes
  ts: string; // ISO
}

import { fileKey } from './fileKey.js';

const journalDir = (root: string): string => join(root, '.repolith', 'journal');
const hashName = (file: string): string => createHash('sha256').update(fileKey(file)).digest('hex').slice(0, 16) + '.jsonl';
const pathFor = (root: string, file: string): string => join(journalDir(root), hashName(file));

/** Append one note for a file. Best-effort — a journal failure must never break the caller. */
export async function appendNote(root: string, note: JournalNote): Promise<void> {
  try {
    await mkdir(journalDir(root), { recursive: true });
    await appendFile(pathFor(root, note.file), JSON.stringify(note) + '\n', 'utf8');
  } catch {
    /* advisory store — swallow */
  }
}

/** Log a denied edit (collision) so it's reviewable after the fact. Advisory: deny notes are
 *  recorded for observability but excluded from the read-before-touch brief (they aren't work
 *  to inherit, and the brief is tuned not to nag). Best-effort via appendNote. */
export async function appendDenyNote(
  root: string,
  file: string,
  deniedSession: string,
  heldBy: string,
  ts: string,
): Promise<void> {
  await appendNote(root, { file, kind: 'deny', msg: `edit blocked — held by ${heldBy}`, session_id: deniedSession, ts });
}

/** Log a wait event — a session that actually blocked on a held file (and later resumed) — so the
 *  wait history is reviewable after the fact. Waits are otherwise live-only: the edge is cleared on
 *  acquire, leaving no record it ever happened. Advisory-logged; excluded from the brief, like deny. */
export async function appendWaitNote(root: string, file: string, sessionId: string, msg: string, ts: string): Promise<void> {
  await appendNote(root, { file, kind: 'wait', msg, session_id: sessionId, ts });
}

/** Log a plan-time overlap catch (Phase 1) — a session's declared plan overlapped another
 *  active session's badly enough to escalate ExitPlanMode to `permissionDecision:"ask"`,
 *  the earliest point a collision can be headed off (before either session has touched a
 *  file). Without this, only the later edit-time catch (deny) left a record. Advisory-logged;
 *  excluded from the brief, like deny/wait. */
export async function appendOverlapNote(
  root: string,
  file: string,
  sessionId: string,
  withSession: string,
  severity: 'hard' | 'shared-surface',
  ts: string,
): Promise<void> {
  await appendNote(root, { file, kind: 'overlap', msg: `plan overlap (${severity}) with ${withSession} — escalated to review`, session_id: sessionId, ts });
}

/** Dedicated aggregate key for Phase-3 semantic surfacings. NOT a real edited-file path (the
 *  parens make it unambiguous), so it never collides with a file journal and is never read by
 *  the read-before-touch brief — it is a single scan point for the false-positive-rate metric. */
export const SEMANTIC_LOG_KEY = '(plan-coordination)/semantic';

/** Log a Phase-3 semantic cross-check surfacing — the plan-time judge block was injected
 *  into a session's context because ≥1 other substantive session was active. Unlike an
 *  overlap note this is NOT a path collision: it fires precisely when path-overlap is
 *  clear, recording that repolith ASKED the agent to check for rename/interface/contract
 *  coupling. Advisory + excluded from the read-before-touch brief (like deny/wait/overlap);
 *  it exists so the live false-positive rate — the signal that decides whether the semantic
 *  layer earns its keep — is measurable instead of invisible.
 *
 *  Keyed to a single aggregate log (SEMANTIC_LOG_KEY), NOT per touched file: a surfacing is a
 *  plan-level event, it's brief-excluded so per-file discoverability buys nothing operationally,
 *  and aggregating means EVERY surfacing is recorded (a plan that declares only globs/dirs has
 *  no concrete file to key on, but is still counted) in one place the metric can scan. Best-effort. */
export async function appendSemanticNote(
  root: string,
  sessionId: string,
  withSession: string,
  ts: string,
): Promise<void> {
  await appendNote(root, { file: SEMANTIC_LOG_KEY, kind: 'semantic', msg: `semantic cross-check surfaced vs ${withSession}`, session_id: sessionId, ts });
}

/** Notes for a file, oldest-first, optionally only those strictly newer than `sinceMs`. */
export async function readNotes(root: string, file: string, sinceMs = 0): Promise<JournalNote[]> {
  let raw: string;
  try {
    raw = await readFile(pathFor(root, file), 'utf8');
  } catch {
    return []; // no journal for this file yet
  }
  const out: JournalNote[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const n = JSON.parse(line) as JournalNote;
      const t = Date.parse(n.ts);
      if (Number.isNaN(t) || t > sinceMs) out.push(n);
    } catch {
      /* skip a corrupt line */
    }
  }
  return out;
}
