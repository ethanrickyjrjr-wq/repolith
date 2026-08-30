// Same-machine, per-workspace store for plan-coordination sessions (Phase 1).
// One JSON file per live session under `<workspace>/.repolith/sessions/`.
// Active = `now - updated_at < ttl_sec`; stale files are lazily pruned on read.
// Phase 5 swaps this backend for the hosted server without changing the API.

import { mkdir, readFile, writeFile, readdir, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';

export interface SessionPlan {
  session_id: string;
  workspace: string;
  summary: string;
  areas: string[];
  status: 'planning';
  plan_excerpt?: string;
  started_at: string; // ISO
  updated_at: string; // ISO
  ttl_sec: number;
  source?: 'exitplan' | 'spec' | 'declare'; // provenance — dashboard + registration-drought debugging
  spec_files?: string[]; // workspace-relative spec files merged into this plan
}

const sessionsDir = (root: string): string => join(root, '.repolith', 'sessions');

// session ids come from Claude Code — keep the on-disk filename filesystem-safe
const sanitize = (id: string): string => id.replace(/[^A-Za-z0-9._-]/g, '_');
const fileFor = (root: string, id: string): string => join(sessionsDir(root), `${sanitize(id)}.json`);

export async function writePlan(root: string, plan: SessionPlan): Promise<void> {
  await mkdir(sessionsDir(root), { recursive: true });
  await writeFile(fileFor(root, plan.session_id), JSON.stringify(plan, null, 2) + '\n', 'utf8');
}

export async function listActive(root: string, nowMs: number): Promise<SessionPlan[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir(root));
  } catch {
    return []; // no store yet
  }
  const out: SessionPlan[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const path = join(sessionsDir(root), name);
    try {
      const plan = JSON.parse(await readFile(path, 'utf8')) as SessionPlan;
      const ts = Date.parse(plan.updated_at);
      if (Number.isNaN(ts)) continue; // leave files with bad timestamps alone
      if (nowMs - ts < plan.ttl_sec * 1000) out.push(plan);
      else await pruneIfStillStale(path, nowMs); // lazy prune of crashed/stale sessions
    } catch {
      // skip corrupt / half-written files
    }
  }
  return out;
}

// TOCTOU-safe lazy prune — same shape as claims.ts's removeClaimIf (§7), lower stakes
// (this layer is warn-only and self-healing). Rename the record aside, re-judge the
// content actually captured, and delete only if it is still stale; a re-registration
// that landed after the read is restored byte-for-byte (`wx` — if the session re-wrote
// itself again meanwhile, the newer record wins). A write racing the other way simply
// re-creates the file via writePlan's plain writeFile, so the session stays registered.
async function pruneIfStillStale(path: string, nowMs: number): Promise<void> {
  const tomb = `${path}.${process.pid.toString(36)}.reap`;
  try {
    await rename(path, tomb);
  } catch {
    return; // gone or locked — another sweep handles it
  }
  let raw: string | null = null;
  try {
    raw = await readFile(tomb, 'utf8');
  } catch {
    raw = null;
  }
  let fresh = false;
  if (raw !== null) {
    try {
      const cur = JSON.parse(raw) as SessionPlan;
      const cts = Date.parse(cur.updated_at);
      fresh = !Number.isNaN(cts) && nowMs - cts < cur.ttl_sec * 1000;
    } catch {
      /* still unreadable → still prunable */
    }
  }
  if (fresh) {
    try {
      await writeFile(path, raw as string, { flag: 'wx' });
    } catch {
      /* newer registration already in place — keep it */
    }
  }
  await unlink(tomb).catch(() => {});
}

export async function clearPlan(root: string, id: string): Promise<void> {
  await unlink(fileFor(root, id)).catch(() => {});
}

/** One session's live plan, or null when absent/stale/corrupt. Stale files are left
 *  for listActive's lazy prune — this is a read, not a sweep. */
export async function readPlan(root: string, id: string, nowMs: number): Promise<SessionPlan | null> {
  try {
    const plan = JSON.parse(await readFile(fileFor(root, id), 'utf8')) as SessionPlan;
    const ts = Date.parse(plan.updated_at);
    if (Number.isNaN(ts) || nowMs - ts >= plan.ttl_sec * 1000) return null;
    return plan;
  } catch {
    return null;
  }
}

/**
 * Merge a fresh registration into a session's existing plan. A session can
 * declare scope more than once (several spec saves, or ExitPlanMode + a spec) —
 * scope accumulates rather than the last write clobbering the rest.
 *
 * areas: union, newest extraction first, capped at 25 (extract.ts' own cap) — a
 * rewritten spec that narrows scope wins the cap fight, but stale areas from an
 * earlier save can survive until TTL (accepted: warn-only layer, over-report bias).
 * summary/excerpt/source: latest write wins. started_at is preserved so the
 * session's age stays honest; updated_at refresh keeps an active session registered.
 */
export function mergePlan(existing: SessionPlan | null, incoming: SessionPlan): SessionPlan {
  if (!existing) return incoming;
  const areas = [...new Set([...incoming.areas, ...existing.areas])].slice(0, 25);
  const spec_files = [...new Set([...(existing.spec_files ?? []), ...(incoming.spec_files ?? [])])];
  return {
    ...incoming,
    areas,
    ...(spec_files.length ? { spec_files } : {}),
    summary: incoming.summary || existing.summary,
    plan_excerpt: incoming.plan_excerpt || existing.plan_excerpt,
    started_at: existing.started_at,
  };
}
