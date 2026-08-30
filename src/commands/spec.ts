// `spec-hook` / `plan declare` — the spec-file → plan-store bridge (T2).
//
// Real sessions declare blast radius in spec/plan .md files, not via
// interactive ExitPlanMode — which is the only surface plan-hook watches.
// Dogfood proof (2026-06-29 EmailLabGridShell): the one overlap that mattered
// was caught by agent diligence reading spec files; repolith never saw it, and
// plan registrations dried up entirely (232 → 0 after 2026-07-18) once
// workflows went spec-driven. This bridge registers a session's scope whenever
// it WRITES a spec-pattern file: PostToolUse on Edit/Write (silent-auto, exact
// session attribution from the hook payload), plus an explicit
// `repolith plan declare <file>` for the executor-session case. SessionStart
// scanning was rejected — a spec file on disk can't be attributed to a
// session, and registering phantom scope is worse than registering none.
//
// PostToolUse can emit additionalContext but NOT permissionDecision (verified
// live 2026-08-02 against code.claude.com/docs/en/hooks) — the spec-save
// warning is advisory; the `ask` escalation remains ExitPlanMode-only. The
// warning landing in the writer's context right after saving the spec IS the
// plan-time catch for this workflow.

import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parseManifest } from '../manifest.js';
import { findManifestUp } from '../locate.js';
import { readHookStdin } from './hook-stdin.js';
import { writePlan, readPlan, mergePlan, listActive, type SessionPlan } from '../coord/store.js';
import { appendOverlapNote } from '../coord/journal.js';
import { pushSnapshot, PUSH_URGENT_MS, PUSH_THROTTLE_MS } from '../coord/snapshotPush.js';
import { extractAreas, firstLine } from '../coord/extract.js';
import { compareAgainstActive, type ConflictReport } from '../coord/overlap.js';
import { renderReport, writePlanNotes } from './plan.js';
import type { WorkspaceManifest } from '../types.js';

export const DEFAULT_SPEC_PATTERNS = ['**/specs/**/*.md', '**/plans/**/*.md', '**/*.plan.md'];

// Never register coordination-internal or VCS paths, whatever the config says.
const EXCLUDED_SEGMENTS = new Set(['.repolith', '.claude', '.git']);

const MAX_SPEC_BYTES = 256 * 1024; // extract from at most the first 256 KB of a spec

export function specPatterns(manifest: WorkspaceManifest): string[] {
  return manifest.coord?.spec_patterns ?? DEFAULT_SPEC_PATTERNS;
}

/** Workspace-relative, forward-slash path for a hook-payload file_path — or null when
 *  the path escapes the workspace root. Windows separators normalized (the live
 *  deployment is Windows; glob patterns are written with `/`). */
export function relativizeSpecPath(root: string, filePath: string): string | null {
  const abs = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const rel = relative(root, abs).replace(/\\/g, '/');
  // `isAbsolute(rel)` is NOT redundant: on Windows a path on another drive has no
  // relative form, so relative('C:\\ws','D:\\plans\\x.md') returns the absolute
  // 'D:/plans/x.md' — not '', not '..', not '../'-prefixed. Without this it slips
  // through, and a spec-pattern match then reads an out-of-workspace file whose
  // excerpt is broadcast to every peer session. Mirrors relInWorkspace (claim.ts).
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

// Minimal glob → RegExp for the pattern shapes spec_patterns needs (`**`, `*`, `?`).
// Dependency-free on purpose — the coordination core stays deterministic and portable
// (Bun.Glob would tie the hook path to the Bun runtime; overlap.ts sets the precedent).
function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // `**/` also matches zero directories
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
      } else {
        re += '[^/]*';
        i += 1;
      }
    } else if (c === '?') {
      re += '[^/]';
      i += 1;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Does a workspace-relative path name a spec file? (Pattern-match before any file
 *  read — this runs on every Edit/Write in the workspace.) */
export function matchesSpecPattern(rel: string, patterns: string[]): boolean {
  if (rel.split('/').some((seg) => EXCLUDED_SEGMENTS.has(seg))) return false;
  return patterns.some((p) => globToRegExp(p).test(rel));
}

export interface SpecRegistration {
  rel: string;
  plan: SessionPlan;
  report: ConflictReport;
  /** Rendered warning when the report has conflicts, else null. */
  context: string | null;
}

/**
 * Register a spec file's scope for a session and compare against the other
 * active sessions. The factored core of spec-hook and `plan declare` (same
 * split as claimBashChanges in bash.ts). Returns null when the path is not a
 * spec (pattern miss, excluded, escapes the root) or can't be read.
 */
export async function registerSpec(
  root: string,
  manifest: WorkspaceManifest,
  sessionId: string,
  filePath: string,
  nowMs: number,
  source: 'spec' | 'declare' = 'spec',
): Promise<SpecRegistration | null> {
  const rel = relativizeSpecPath(root, filePath);
  if (!rel || !matchesSpecPattern(rel, specPatterns(manifest))) return null;

  let text: string;
  try {
    text = (await readFile(isAbsolute(filePath) ? filePath : resolve(root, filePath), 'utf8')).slice(0, MAX_SPEC_BYTES);
  } catch {
    return null; // deleted/unreadable between hook fire and read → nothing to register
  }

  const now = new Date(nowMs).toISOString();
  // The spec's own path self-references constantly (and lives next to other specs) —
  // registering it would make every co-located spec pair a false overlap on the specs dir.
  const areas = extractAreas(text).filter((a) => a !== rel);
  const me: SessionPlan = {
    session_id: sessionId,
    workspace: manifest.name,
    summary: firstLine(text),
    areas,
    status: 'planning',
    plan_excerpt: text.slice(0, 800),
    started_at: now,
    updated_at: now,
    ttl_sec: 3600,
    source,
    spec_files: [rel],
  };
  const merged = mergePlan(await readPlan(root, sessionId, nowMs), me);
  await writePlan(root, merged);
  await writePlanNotes(root, me).catch(() => {}); // only this registration's areas — no duplicate notes for merged-in old scope

  const others = await listActive(root, nowMs);
  const report = compareAgainstActive(merged, others);
  const escalates = report.conflicts.some((c) => c.severity === 'hard' || c.severity === 'shared-surface');
  await pushSnapshot(root, escalates ? PUSH_URGENT_MS : PUSH_THROTTLE_MS).catch(() => {});

  if (escalates) {
    // Same reviewability contract as plan-hook: every hard/shared pair leaves an
    // overlap journal line, so a plan-time catch is auditable after the fact.
    for (const c of report.conflicts) {
      for (const p of c.pairs) {
        if (p.severity === 'soft') continue;
        const isConcrete = (s: string) => !/[*?[{]/.test(s);
        const file = isConcrete(p.a) ? p.a : isConcrete(p.b) ? p.b : p.a;
        await appendOverlapNote(root, file, sessionId, c.with_session, p.severity, now).catch(() => {});
      }
    }
  }

  const context = report.clear
    ? null
    : `repolith: your spec save (${rel}) declares scope overlapping other active work —\n\n${renderReport(report)}`;
  return { rel, plan: merged, report, context };
}

interface SpecHookPayload {
  session_id?: string;
  cwd?: string;
  tool_input?: { file_path?: string };
}

/** PostToolUse Edit/Write hook entry point. Advisory only — any failure exits 0 silently. */
export async function specHook(): Promise<void> {
  const raw = (await readHookStdin()).trim();
  if (!raw) return;
  let ev: SpecHookPayload;
  try {
    ev = JSON.parse(raw) as SpecHookPayload;
  } catch {
    return; // unparseable payload → never break the user's edit flow
  }
  const filePath = ev.tool_input?.file_path;
  if (!ev.session_id || !filePath) return;

  const manifestPath = await findManifestUp(ev.cwd || process.cwd());
  if (!manifestPath) return; // not a repolith workspace → stay out of the way
  const root = dirname(manifestPath);
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));

  const reg = await registerSpec(root, manifest, ev.session_id, filePath, Date.now());
  if (!reg?.context) return; // no spec, or no overlap → silent
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: reg.context } }),
  );
}

/** `repolith plan declare <file>` — explicit registration for sessions executing a
 *  spec they didn't write (the case the Write/Edit hook can't attribute). */
export async function planDeclare(manifestPath: string, file: string, opts: { session?: string }): Promise<void> {
  const root = dirname(resolve(manifestPath));
  const manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  const sessionId = opts.session || process.env['CLAUDE_SESSION_ID'] || `declare-${process.pid}`;

  const reg = await registerSpec(root, manifest, sessionId, file, Date.now(), 'declare');
  if (!reg) {
    console.log(
      `Not registered: ${file} is unreadable, escapes the workspace, or matches no spec pattern ` +
        `(${specPatterns(manifest).join(', ')}).`,
    );
    return;
  }
  console.log(`Registered ${reg.rel} for session ${sessionId} — ${reg.plan.areas.length} area(s).`);
  if (reg.context) console.log(`\n${reg.context}`);
  else {
    const others = (await listActive(root, Date.now())).filter((p) => p.session_id !== sessionId);
    console.log(`No overlap with ${others.length} other active session(s).`);
  }
}
