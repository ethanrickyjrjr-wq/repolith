// Phase 3 — semantic coordination layer (delegated judge).
//
// Path-overlap (overlap.ts) catches file COLLISIONS — two plans touching the same
// path. It is blind to the nasty disjoint case that motivates this whole phase:
// session A renames a function in `auth.ts` that session B calls from `billing.ts`.
// Different files, zero path overlap, a real conflict. Path comparison reports
// `clear`; the collision surfaces only later, at merge.
//
// House philosophy (see brief.ts:117-120): repolith does NOT adjudicate with an
// LLM. The coordinating agent is itself a frontier model, already in context with
// its task AND its own advisor/review — a strictly more capable judge than any
// sub-agent repolith could spawn, and one that costs repolith no vendor surface,
// no API key, no model call. So the "semantic judge" is DELEGATION: when other
// sessions are active, hand the planning agent the other plans' intent plus a
// rename/interface/contract checklist and ask IT to judge — before it edits.
//
// This layer is purely ADVISORY. Unlike a hard path collision it never escalates
// to a `permissionDecision:"ask"` block: a semantic judgment is probabilistic
// (design §8.3 "an assist, not a proof"; §8.4 "over-blocking kills the workflow"),
// so it injects awareness and lets the agent decide. It degrades to nothing —
// no other active session, or nobody with a substantive plan → null, silence.

import { cleanContext } from './sanitize.js';

export interface SemanticPlanView {
  session_id: string;
  summary?: string;
  areas?: string[];
  plan_excerpt?: string;
}

const EXCERPT_CHARS = 240; // enough intent to judge coupling; short enough to stay cheap in-context
const MAX_OTHERS = 6; // cap the block; more than a handful of parallel sessions is its own problem

/** Does this plan carry enough intent to be worth cross-checking? */
function substantive(p: SemanticPlanView): boolean {
  return Boolean((p.summary && p.summary.trim()) || (p.plan_excerpt && p.plan_excerpt.trim()) || p.areas?.length);
}

/** The OTHER active sessions worth cross-checking `me` against — every peer with a
 *  substantive plan. Shared by the renderer and the observability logger so the journal
 *  records exactly the peers the injected block named (no over- or under-counting). */
export function semanticPeers(me: SemanticPlanView, others: SemanticPlanView[]): SemanticPlanView[] {
  return others.filter((o) => o.session_id !== me.session_id && substantive(o));
}

/** A compact one-line excerpt of another plan's intent for the checklist —
 *  sanitized (finding 10: this is store-sourced text entering a peer's context). */
function excerptOf(p: SemanticPlanView): string {
  return cleanContext((p.plan_excerpt || '').replace(/\s+/g, ' ').trim(), EXCERPT_CHARS);
}

/**
 * Build the semantic cross-check block injected into the planning agent's context,
 * or null when there is nothing worth asking about (no OTHER active session with a
 * substantive plan). Fires INDEPENDENTLY of path overlap — its whole reason to
 * exist is the path-disjoint-but-semantically-coupled case that `overlap()` misses.
 */
export function renderSemanticCheck(me: SemanticPlanView, others: SemanticPlanView[]): string | null {
  const peers = semanticPeers(me, others);
  if (!peers.length) return null;

  const n = peers.length;
  const lines: string[] = [
    `🧠 repolith semantic cross-check — ${n} other active session${n === 1 ? '' : 's'}. ` +
      `Path-overlap is reported separately; this catches coupling it CANNOT see (a symbol you rename that they call, a signature/type/contract you change that they depend on).`,
  ];
  for (const p of peers.slice(0, MAX_OTHERS)) {
    lines.push(`  • "${cleanContext(p.summary?.trim() || '') || '(no summary)'}" (${cleanContext(p.session_id, 80)})`);
    if (p.areas?.length) lines.push(`      areas: ${p.areas.map((a) => cleanContext(a, 120)).join(', ')}`);
    const ex = excerptOf(p);
    if (ex) lines.push(`      intent: ${ex}`);
  }
  if (n > MAX_OTHERS) lines.push(`  • …and ${n - MAX_OTHERS} more (see \`repolith plan list\`).`);
  lines.push('');
  lines.push(
    'For EACH session above, ask: does my plan rename or move a symbol, change a function signature, ' +
      'alter a type/interface, change an API/response contract, or touch a shared enum/constant/migration ' +
      "that this session's work depends on — or vice-versa? None of those show up as path overlap.",
  );
  lines.push(
    'If yes → coordinate before editing (claim the file that defines the shared symbol, serialize, or re-scope). ' +
      'Advisory — repolith is not adjudicating this; you decide.',
  );
  return lines.join('\n');
}
