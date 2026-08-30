// Read-before-touch brief + self-anchor (Phase 2.5, thin slice).
//
// When a session FIRST touches a file (claim status new/took-over), the edit-hook
// asks for a brief to inject as PreToolUse `additionalContext`. The brief carries
// two things:
//   1. Read-before-touch — the journal notes for this file from OTHER sessions /
//      commits that this session hasn't seen yet (so it inherits, not clobbers).
//   2. Self-anchor (drift control) — re-grounds the session in its own declared
//      task. Tuned to NOT nag (advisor: noise = the feature gets turned off):
//        • scope-creep flag fires whenever the file is outside the declared areas
//          (high signal, the actual drift catch);
//        • the full task restatement fires only when out-of-scope, or ONCE per
//          session on the first in-scope touch — never on every clean edit.
//
// Per-session state (a "seen" cursor + an "anchored" flag) lives in
// <root>/.repolith/seen/<sessionhash>.json. All best-effort: any failure → null,
// the edit proceeds silently.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listActive } from './store.js';
import { readNotes, type NoteKind } from './journal.js';
import { fileKey } from './fileKey.js';
import { cleanContext } from './sanitize.js';

// Note kinds that are an observability log of collisions / catches / locks — NOT work to
// inherit — so they're kept out of the read-before-touch brief (which is tuned not to nag):
//   deny/wait/overlap/semantic — collision & plan-catch records.
//   claim                      — a lock announcement, not content. By the time buildBrief runs,
//                                the claim gate has already granted THIS session the file
//                                (status new/took-over — a live claim returns `held` and never
//                                reaches here), so any claim note the brief could show is
//                                necessarily stale-or-self. Replaying it surfaced long-dead
//                                sessions' locks as a live "read before editing" conflict.
//   coedit                     — the Bash co-edit soft-note ("changed in my window but the
//                                holder was active elsewhere — not a clobber"); pure
//                                observability about a non-event, and often about this very
//                                session, so it must never ride into a peer's brief.
const BRIEF_EXCLUDED: ReadonlySet<NoteKind> = new Set(['deny', 'wait', 'overlap', 'semantic', 'claim', 'coedit']);

interface SeenState {
  anchored?: boolean; // has this session had its task restated once?
  files?: Record<string, number>; // fileHash → newest note ts (ms) already shown
}

const MAX_NOTES = 5;
const NOTES_WINDOW_MS = 48 * 60 * 60 * 1000; // hide notes older than 48 h to keep the brief from going stale

const seenDir = (root: string): string => join(root, '.repolith', 'seen');
const sessHash = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 16);
const fileHash = (file: string): string => createHash('sha256').update(fileKey(file)).digest('hex').slice(0, 16);
const seenPath = (root: string, id: string): string => join(seenDir(root), `${sessHash(id)}.json`);

async function readSeen(root: string, id: string): Promise<SeenState> {
  try {
    return JSON.parse(await readFile(seenPath(root, id), 'utf8')) as SeenState;
  } catch {
    return {};
  }
}
async function writeSeen(root: string, id: string, s: SeenState): Promise<void> {
  try {
    await mkdir(seenDir(root), { recursive: true });
    await writeFile(seenPath(root, id), JSON.stringify(s, null, 2) + '\n', 'utf8');
  } catch {
    /* advisory — swallow */
  }
}

/** Is `file` covered by any of the session's declared `areas`?
 *
 *  Membership is asymmetric and TIGHT — an area covers `file` only when it IS the file
 *  (concrete file: exact, or repo-relative path-suffix) or an ANCESTOR of it (directory /
 *  glob prefix). This deliberately does NOT reuse `overlap()`, which is symmetric and
 *  generous on purpose (it over-reports for plan-vs-plan *warnings*). Using that generosity
 *  as a scope-membership test let two classes of file silently ride into any plan's scope —
 *  same-dir siblings (`src/auth/login.ts` "covering" `src/auth/oauth.ts`) and root-level
 *  files (an empty dir is a prefix of everything) — i.e. scope-creep false-negatives. */
function inDeclaredScope(areas: string[], file: string): boolean {
  return areas.some((area) => {
    const hadTrailingSlash = /\/$/.test(area);
    const a = area.replace(/\/+$/, '').trim();
    if (!a) return false; // empty / root area covers nothing (was: covered everything)
    if (/[*?{[]/.test(a)) {
      // glob → match by its literal directory prefix
      const lit = a.slice(0, a.search(/[*?{[]/)).replace(/\/+$/, '');
      return lit ? dirCovers(lit, file) : true; // bare glob (`**`) covers everything
    }
    // Concrete area. A trailing slash, or a final segment with no extension, reads as a
    // DIRECTORY (covers its descendants). Otherwise it's a FILE — exact or repo-relative
    // suffix only, never its siblings.
    const last = a.slice(a.lastIndexOf('/') + 1);
    const fileLike = !hadTrailingSlash && last.includes('.');
    return fileLike ? file === a || file.endsWith('/' + a) : dirCovers(a, file);
  });
}

/** Does directory/prefix `dir` contain or equal workspace-relative `file`? Handles the
 *  repo-relative-vs-workspace-relative case (the declared `dir` can appear mid-path). */
function dirCovers(dir: string, file: string): boolean {
  return file === dir || file.startsWith(dir + '/') || file.includes('/' + dir + '/') || file.endsWith('/' + dir);
}

/** Build the first-touch brief for `file`, or null if there's nothing worth saying. */
export async function buildBrief(root: string, sessionId: string, file: string, nowMs: number): Promise<string | null> {
  const seen = await readSeen(root, sessionId);
  const lines: string[] = [];
  let dirty = false;

  // 1. Read-before-touch: unseen notes from others/commits about this file.
  const fh = fileHash(file);
  const cursor = seen.files?.[fh] ?? 0;
  const notes = (await readNotes(root, file))
    .filter((n) => !BRIEF_EXCLUDED.has(n.kind) && n.session_id !== sessionId && (Date.parse(n.ts) || 0) > cursor)
    .filter((n) => nowMs - (Date.parse(n.ts) || 0) < NOTES_WINDOW_MS);
  if (notes.length) {
    lines.push(`📋 ${file} — ${notes.length} update(s) from other sessions you haven't seen; read before editing:`);
    for (const n of notes.slice(-MAX_NOTES)) {
      // Store-sourced text (msg / ids / shas) is cleaned at every injection sink — finding 10.
      const who = n.session_id ? ` —${cleanContext(n.session_id, 80)}` : '';
      const sha = n.sha ? ` (${cleanContext(n.sha.slice(0, 8), 8)})` : '';
      lines.push(`   • ${n.kind}: ${cleanContext(n.msg)}${sha}${who} [${ago(n.ts, nowMs)}]`);
    }
    const maxTs = Math.max(...notes.map((n) => Date.parse(n.ts) || 0));
    seen.files = { ...(seen.files ?? {}), [fh]: maxTs };
    dirty = true;
  }

  // 2. Self-anchor (drift control), value-tuned so it isn't a nag.
  const me = (await listActive(root, nowMs)).find((p) => p.session_id === sessionId);
  if (me && me.areas.length) {
    if (!inDeclaredScope(me.areas, file)) {
      // Deterministic heuristic flag only — repolith does NOT adjudicate with an LLM.
      // The flag is ADVISORY: the coordinating agent (which has its own advisor/review,
      // e.g. superpowers) verifies and decides. Declared areas can be lossy (prose-extracted
      // by `extractAreas`), so this is a prompt to check, not a verdict to obey.
      lines.push(`↻ Your task: ${cleanContext(me.summary) || '(no summary)'}`);
      lines.push(`   Declared areas: ${me.areas.map((a) => cleanContext(a, 120)).join(', ')}`);
      lines.push(
        `   ⚠️ ${file} is OUTSIDE your declared areas — possible scope creep. Advisory, not a block: confirm it's on-task (consult your advisor / request review if unsure), or re-scope.`,
      );
    } else if (!seen.anchored) {
      lines.push(`↻ Your task: ${cleanContext(me.summary) || '(no summary)'} — editing ${file} (in scope).`);
      seen.anchored = true;
      dirty = true;
    }
  }

  if (dirty) await writeSeen(root, sessionId, seen);
  return lines.length ? lines.join('\n') : null;
}

function ago(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  if (Number.isNaN(ms)) return 'recently';
  const m = Math.round(ms / 60000);
  if (m < 1) return 'just now';
  if (m === 1) return '1 min ago';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}
