// Deterministic path-overlap comparator for plan coordination (Phase 1).
//
// Pure and dependency-free. It is segment/prefix based and deliberately
// OVER-reports rather than under-reports — Phase 1 only *warns*, never blocks,
// so a false positive costs a glance while a false negative costs a collision.
// Mid-path `**` and brace sets are approximated by their literal prefix.
// True glob-vs-glob intersection + concrete claim matching arrive in Phase 2.
//
// This layer sees only PATH collisions. It is blind by construction to the
// path-disjoint-but-coupled case (a renamed symbol called from another file) —
// that is the Phase 3 semantic layer's job (coord/semantic.ts), which fires
// exactly when this comparator returns `clear`.

export type Severity = 'hard' | 'soft' | 'shared-surface';

// Files where two plans clash semantically even if the lines don't overlap.
const SHARED_SURFACE: RegExp[] = [
  /(^|\/)types\.ts$/,
  /(^|\/)package\.json$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)[^/]+\.lock(\.json)?$/,
  /(^|\/)migrations?\//,
  /(^|\/)[^/]+\.config\.[cmjt]+s$/,
  /(^|\/)\.env/,
];

interface Area {
  dir: string[]; // literal directory segments
  file: string[] | null; // full segments when the area is a concrete file (no glob)
  recursive: boolean; // pattern contains `**` → can subsume descendants
}

function parse(area: string): Area {
  const meta = area.search(/[*?[{]/);
  const concrete = meta === -1;
  let literal = concrete ? area : area.slice(0, meta);
  // a partial last segment (e.g. `dock` in `dock*`) is not a safe directory bound
  if (!concrete && !literal.endsWith('/')) literal = literal.slice(0, literal.lastIndexOf('/') + 1);
  const parts = literal.split('/').filter(Boolean);
  if (concrete) return { dir: parts.slice(0, -1), file: parts, recursive: false };
  return { dir: parts, file: null, recursive: /\*\*/.test(area) };
}

const isPrefix = (a: string[], b: string[]): boolean =>
  a.length <= b.length && a.every((p, i) => p === b[i]);

/** Severity of the overlap between two area patterns, or null when disjoint. */
export function overlap(a: string, b: string): Severity | null {
  if (!a.trim() || !b.trim()) return null;
  const base = baseSeverity(parse(a), parse(b));
  if (!base) return null;
  return SHARED_SURFACE.some((re) => re.test(a) || re.test(b)) ? 'shared-surface' : base;
}

function baseSeverity(A: Area, B: Area): 'hard' | 'soft' | null {
  if (A.file && B.file) {
    // two concrete files
    if (A.file.join('/') === B.file.join('/')) return 'hard';
    return isPrefix(A.dir, B.dir) || isPrefix(B.dir, A.dir) ? 'soft' : null; // siblings in a shared dir
  }
  if (A.file || B.file) {
    // one concrete file, one glob: hard if the glob's dir can contain the file
    const glob = A.file ? B : A;
    const fileDir = (A.file ?? B.file)!.slice(0, -1);
    if (!isPrefix(glob.dir, fileDir)) return null;
    return glob.recursive || glob.dir.length === fileDir.length ? 'hard' : 'soft';
  }
  // two globs: do they share a directory ancestor?
  if (isPrefix(A.dir, B.dir) || isPrefix(B.dir, A.dir)) return A.recursive || B.recursive ? 'hard' : 'soft';
  return null;
}

export interface PlanLike {
  session_id: string;
  summary: string;
  areas: string[];
}

export interface OverlapPair {
  a: string;
  b: string;
  severity: Severity;
}

export interface Conflict {
  with_session: string;
  with_summary: string;
  severity: Severity; // max severity across pairs
  pairs: OverlapPair[];
  recommendation: string;
}

export interface ConflictReport {
  clear: boolean;
  conflicts: Conflict[];
}

// hard outranks shared-surface: a same-file collision is the single most
// important thing to surface and must never be masked by a co-occurring
// shared-surface overlap. shared-surface still outranks soft and still escalates.
const RANK: Record<Severity, number> = { soft: 1, 'shared-surface': 2, hard: 3 };

/** Compare one plan's blast radius against every other active session. */
export function compareAgainstActive(me: PlanLike, others: PlanLike[]): ConflictReport {
  const mine = dedupe(me.areas);
  const conflicts: Conflict[] = [];
  for (const other of others) {
    if (other.session_id === me.session_id) continue;
    const pairs: OverlapPair[] = [];
    for (const a of mine) {
      for (const b of dedupe(other.areas)) {
        const severity = overlap(a, b);
        if (severity) pairs.push({ a, b, severity });
      }
    }
    if (pairs.length) {
      const severity = pairs.reduce<Severity>((m, p) => (RANK[p.severity] > RANK[m] ? p.severity : m), 'soft');
      conflicts.push({
        with_session: other.session_id,
        with_summary: other.summary,
        severity,
        pairs,
        recommendation: recommend(severity),
      });
    }
  }
  conflicts.sort((x, y) => RANK[y.severity] - RANK[x.severity]);
  return { clear: conflicts.length === 0, conflicts };
}

function recommend(s: Severity): string {
  if (s === 'shared-surface')
    return 'shared surface touched by both — review together; a semantic clash is likely even if lines do not overlap';
  if (s === 'hard')
    return 'serialize — the other session already owns this path; wait for it to finish or re-scope off the overlap';
  return 'proceed with awareness — adjacent work; review at merge';
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}
