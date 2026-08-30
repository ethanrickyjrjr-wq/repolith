// Plan-coordination CLI surface (Phase 1).
//
// `plan-hook`  — the single command the PreToolUse/ExitPlanMode hook invokes.
//                Reads the raw Claude Code hook payload on stdin, registers the
//                plan, compares it against other active sessions, and prints a
//                PreToolUse hookSpecificOutput JSON (additionalContext, plus
//                permissionDecision:"ask" on a hard conflict). On no conflict it
//                prints nothing and exits 0 — normal plan-approval flow proceeds.
// `plan list`  — show active sessions + their declared blast radius.
// `plan clear` — force-release a session by id.

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { parseManifest } from '../manifest.js';
import { findManifestUp } from '../locate.js';
import { readHookStdin } from './hook-stdin.js';
import { writePlan, readPlan, mergePlan, listActive, clearPlan, type SessionPlan } from '../coord/store.js';
import { releaseSession } from '../coord/claims.js';
import { relInWorkspace } from './claim.js';
import { appendNote, appendOverlapNote, appendSemanticNote } from '../coord/journal.js';
import { pushSnapshot, PUSH_URGENT_MS, PUSH_THROTTLE_MS } from '../coord/snapshotPush.js';
import { extractAreas, firstLine } from '../coord/extract.js';
import { compareAgainstActive, type ConflictReport, type OverlapPair } from '../coord/overlap.js';
import { renderSemanticCheck, semanticPeers } from '../coord/semantic.js';
import { cleanContext } from '../coord/sanitize.js';

interface HookPayload {
  session_id?: string;
  cwd?: string;
  permission_mode?: string;
  tool_input?: { plan?: string; planFilePath?: string };
}

export async function planHook(): Promise<void> {
  const raw = (await readHookStdin()).trim();
  if (!raw) return; // no payload → exit 0, normal flow
  let ev: HookPayload;
  try {
    ev = JSON.parse(raw) as HookPayload;
  } catch {
    return; // unparseable payload → never break the user's plan flow
  }

  // No session identity → bail, like bash-pre/post-hook and spec-hook (finding 12).
  // The old `hook-${pid}` fallback minted a NEW identity per hook process, so such a
  // "session" could never renew, release, or be attributed — pure store litter.
  if (!ev.session_id) return;

  const manifestPath = await findManifestUp(ev.cwd || process.cwd());
  if (!manifestPath) return; // not a repolith workspace → stay out of the way
  const root = dirname(manifestPath);
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));

  const plan = await readPlanText(ev.tool_input, root);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const me: SessionPlan = {
    session_id: ev.session_id,
    workspace: manifest.name,
    summary: firstLine(plan),
    areas: extractAreas(plan),
    status: 'planning',
    plan_excerpt: plan.slice(0, 800),
    started_at: now,
    updated_at: now,
    ttl_sec: 3600,
    source: 'exitplan',
  };
  // Merge, don't clobber — a session may already have spec-derived scope (spec.ts
  // bridge) and ExitPlanMode narrowing shouldn't drop it. Compare with the full
  // merged blast radius.
  const merged = mergePlan(await readPlan(root, me.session_id, nowMs), me);
  await writePlan(root, merged);
  await writePlanNotes(root, me).catch(() => {}); // advisory — never break plan flow

  const others = await listActive(root, nowMs);
  const report = compareAgainstActive(merged, others);
  // Escalate on the most urgent kind present. NEVER bare "allow" for ExitPlanMode
  // (insufficient + only matters in -p); "ask" makes the human re-look while the
  // conflict sits in the agent's context.
  const hasHard = report.conflicts.some((c) => c.severity === 'hard');
  const hasShared = report.conflicts.some((c) => c.severity === 'shared-surface');
  const escalates = hasHard || hasShared;
  // One push per hook run, at the throttle matching this run's urgency — an overlap catch
  // is the urgent signal (like deny), so it earns the tighter window; a routine plan
  // registration gets the generous one. (Two sequential calls here would hit the same
  // lock file back-to-back and could double the hook's upload latency for no benefit.)
  await pushSnapshot(root, escalates ? PUSH_URGENT_MS : PUSH_THROTTLE_MS);

  // Phase 3 — semantic cross-check. Fires INDEPENDENTLY of path overlap: the
  // flagship case (a symbol I rename that another session calls from a different
  // file) is path-DISJOINT, so `report.clear` is true yet a real conflict exists.
  // Advisory only — it never sets `permissionDecision` (that stays path-driven).
  const semantic = renderSemanticCheck(me, others);
  if (report.clear && !semantic) return; // truly nothing to say → silent, normal approval UI

  // Observability: record that the semantic judge was surfaced (one note per peer,
  // aggregated to SEMANTIC_LOG_KEY), so the live false-positive rate — the signal that
  // decides if this layer earns its keep — is measurable. Advisory; never blocks the plan flow.
  if (semantic) {
    for (const peer of semanticPeers(me, others)) {
      await appendSemanticNote(root, me.session_id, peer.session_id, now).catch(() => {});
    }
  }

  const context = [report.clear ? '' : renderReport(report), semantic ?? ''].filter(Boolean).join('\n\n');
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: 'PreToolUse',
    additionalContext: context,
  };
  if (escalates) {
    hookSpecificOutput.permissionDecision = 'ask';
    hookSpecificOutput.permissionDecisionReason = hasHard
      ? 'repolith: this plan edits the same file as another active session — review before proceeding.'
      : 'repolith: this plan touches a shared surface another active session also edits — review before proceeding.';

    // Log every hard/shared-surface pair so a plan-time catch is reviewable after the fact —
    // otherwise only the later edit-time catch (deny) left a record of a collision avoided.
    for (const c of report.conflicts) {
      for (const p of c.pairs) {
        if (p.severity === 'soft') continue;
        await appendOverlapNote(root, overlapFile(p), me.session_id, c.with_session, p.severity, now).catch(() => {});
      }
    }
  }
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

/** Journal key for an overlapping area pair — prefer whichever side is a concrete file (matches
 *  how a later edit on that exact path will look it up); fall back to my own declared area. */
function overlapFile(pair: OverlapPair): string {
  const isConcrete = (s: string) => !/[*?[{]/.test(s);
  if (isConcrete(pair.a)) return pair.a;
  if (isConcrete(pair.b)) return pair.b;
  return pair.a;
}

/**
 * Plan text for a captured ExitPlanMode payload. Claude Code injects
 * `tool_input.plan` (the plan content, read from the on-disk plan file) before the
 * hook runs — that's the normal path, verified live against the canonical hooks
 * docs 2026-06-28 ("Plan content in Markdown. Injected from the plan file on
 * disk"). As belt-and-suspenders for any CC version that injects only
 * `planFilePath` (also documented "Injected"), fall back to reading that file when
 * `plan` is empty. A missing/unreadable file yields '' — never break the plan flow.
 *
 * `planFilePath` arrives on hook stdin and is therefore UNTRUSTED — the same trust
 * boundary editHook and specHook validate before touching a payload-supplied path.
 * It must stay contained to the workspace: whatever this returns becomes the plan
 * `summary` (first line) and `plan_excerpt` (first 800 chars), and those are broadcast
 * into every other active session's context for the session's TTL. Without the check,
 * anything able to reach this hook reads an arbitrary local file (`.env.local`, a key)
 * straight into peer agents' context.
 */
export async function readPlanText(
  toolInput: { plan?: string; planFilePath?: string } | undefined,
  root: string,
): Promise<string> {
  const inline = toolInput?.plan;
  if (inline && inline.trim()) return inline;
  const path = toolInput?.planFilePath;
  if (path) {
    const rel = relInWorkspace(root, isAbsolute(path) ? path : resolve(root, path));
    if (rel) {
      try {
        return await readFile(resolve(root, rel), 'utf8');
      } catch {
        /* unreadable → fall through to '' */
      }
    } else {
      // Leave a trace rather than failing silently. If Claude Code ever moves plan files
      // out of the workspace (its own state dir) AND switches to planFilePath-only
      // injection, every plan would degrade to '' → no areas → overlap detection quietly
      // stops catching anything, with nothing anywhere saying why. Hook stderr on a
      // non-blocking exit is advisory and never breaks the plan flow.
      console.error(`repolith: ignoring planFilePath outside the workspace (${path}) — plan scope not read from disk.`);
    }
  }
  return inline ?? '';
}

/** Append a plan note for each concrete-file area (globs and dirs are skipped).
 *  Shared with the spec-file bridge (commands/spec.ts) — these per-file `plan` journal
 *  lines are what other sessions' read-before-touch briefs surface as intent. */
export async function writePlanNotes(root: string, plan: SessionPlan): Promise<void> {
  const ts = new Date().toISOString();
  for (const area of plan.areas) {
    if (area.endsWith('/') || /[*?{[]/.test(area)) continue; // skip globs + dir declarations
    const last = area.slice(area.lastIndexOf('/') + 1);
    if (!last.includes('.')) continue; // skip dirs (no file extension)
    await appendNote(root, { file: area, kind: 'plan', msg: plan.summary || '(planning)', session_id: plan.session_id, ts });
  }
}

/** Compact, ≤10k-char human block injected into the planning session's context. */
export function renderReport(report: ConflictReport): string {
  const n = report.conflicts.length;
  const lines: string[] = [
    `⚠️ repolith plan-coordination — ${n} active session${n === 1 ? '' : 's'} overlap${n === 1 ? 's' : ''} this plan:`,
  ];
  for (const c of report.conflicts) {
    const icon = c.severity === 'hard' ? '🔴' : c.severity === 'shared-surface' ? '🟠' : '🟡';
    // Store-sourced summaries/ids/areas are cleaned at every injection sink — finding 10.
    lines.push(`  ${icon} ${c.severity} — session "${cleanContext(c.with_summary || c.with_session)}" (${cleanContext(c.with_session, 80)})`);
    for (const p of c.pairs.slice(0, 6)) lines.push(`       ${cleanContext(p.a, 120)}  ×  ${cleanContext(p.b, 120)}  [${p.severity}]`);
    lines.push(`     → ${c.recommendation}`);
  }
  lines.push('');
  lines.push('repolith Phase-1 plan coordination (warn-only, path-overlap). Decide before you start editing.');
  return lines.join('\n').slice(0, 9500);
}

export async function planList(manifestPath: string): Promise<void> {
  const root = dirname(resolve(manifestPath));
  const active = await listActive(root, Date.now());
  if (!active.length) {
    console.log('No active planning sessions.');
    return;
  }
  for (const p of active) {
    console.log(`${p.session_id}  [${p.workspace}]  ${p.summary || '(no summary)'}`);
    for (const a of p.areas) console.log(`    ${a}`);
  }
}

export async function planClear(manifestPath: string, id: string): Promise<void> {
  const root = dirname(resolve(manifestPath));
  await clearPlan(root, id);
  const released = await releaseSession(root, id); // a force-released session drops its file claims too
  console.log(`Cleared session ${id}${released ? ` and released ${released} file claim(s)` : ''}.`);
}
