// Deterministic area extraction from a prose plan (Phase 1 floor).
//
// Lossy on purpose — it pulls path/glob-shaped tokens out of plan markdown so
// the ExitPlanMode hook (which has no agent to declare areas) still gets a
// blast radius. Callers that *can* declare `areas` explicitly should, since an
// agent that just wrote the plan predicts its own paths far better (plan §3.2).
//
// NB: an earlier plan sketched an "LLM extraction pass" to replace this in Phase 3.
// That is NOT how Phase 3 shipped — repolith does not adjudicate/extract with an LLM
// (house rule, brief.ts). This regex floor + caller-declared `areas` (§3.2) +
// claim-on-first-touch stay the blast-radius story; the Phase 3 semantic judge
// (coord/semantic.ts) delegates the harder reasoning to the coordinating agent.

const FENCE = /```[\s\S]*?```/g; // code fences are noisy — drop before prose scan
const BACKTICK = /`([^`]+)`/g; // backtick spans usually hold the real paths
const PATHISH = /(?:\.{1,2}\/)?(?:[\w@.-]+\/)+[\w@.*-]+/g; // a/b, a/b/**, a/b.ts ...

export function extractAreas(plan: string | undefined): string[] {
  if (!plan) return [];
  const text = plan.replace(/https?:\/\/\S+/g, ' '); // drop URLs whole (else host/path leaks as a pseudo-path)
  const found = new Set<string>();
  // 1. backtick spans (highest signal)
  for (const m of text.matchAll(BACKTICK)) {
    for (const t of m[1].matchAll(PATHISH)) found.add(normalize(t[0]));
  }
  // 2. bare path-ish tokens in the prose (fences removed to cut noise)
  for (const m of text.replace(FENCE, ' ').matchAll(PATHISH)) found.add(normalize(m[0]));
  return [...found].filter(isLikelyPath).slice(0, 25);
}

function normalize(t: string): string {
  return t.replace(/[).,;:]+$/, '').trim(); // strip trailing prose punctuation
}

const DATE_NUMERIC = /^\d{1,4}(?:\/\d{1,4}){1,2}$/; // 06/30/2026, 2026/07/01
const DATE_PLACEHOLDER = /^[MDYmdy]{2,4}(?:\/[MDYmdy]{2,4}){1,2}$/; // MM/DD/YYYY, dd/mm/yy

function isLikelyPath(t: string): boolean {
  if (/^https?:\/\//.test(t)) return false; // URLs
  if (/[()]/.test(t)) return false;
  if (t.length < 4 || t.length > 120) return false;
  // dates satisfy the depth rule below but are never claimable paths
  if (DATE_NUMERIC.test(t) || DATE_PLACEHOLDER.test(t)) return false;
  const slashes = (t.match(/\//g) ?? []).length;
  if (slashes === 0) return false;
  // require a file extension, a glob, or real depth — kills prose like "and/or"
  return slashes >= 2 || /[.*]/.test(t);
}

/** First non-empty line/heading of a plan → a one-line summary. */
export function firstLine(plan: string | undefined): string {
  if (!plan) return '';
  for (const raw of plan.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim();
    if (line) return line.slice(0, 120);
  }
  return '';
}
