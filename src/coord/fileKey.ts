// Canonical store key for a workspace-relative file path.
//
// Two independent producers turn a touched file into a store key, and they must
// agree or the coordination gates silently stop seeing each other's records:
//
//   - the Edit/Write gate (commands/claim.ts) derives it from the tool payload's
//     `file_path` — whatever casing the agent typed;
//   - the Bash-bypass backstop (coord/bashDiff.ts) derives it from
//     `git status --porcelain` — whatever casing git recorded in the index.
//
// Those two strings are structurally identical (same separators, same repo
// prefix), so case is the only axis on which they diverge. On a case-insensitive
// filesystem `src/Types.ts` and `src/types.ts` are ONE file, but they hash to two
// different claim records — so the Edit gate and the Bash backstop each think they
// hold it exclusively while clobbering the same bytes. Fold case there, and only
// there: on Linux those genuinely are two different files, and folding would make
// the gate deny edits to a file nobody holds.
//
// Applied to the *hash input* only — the human-readable path stored inside the
// record and shown in deny messages keeps the caller's original casing.

/** Canonicalize a file path for use as a store-key hash input. */
export function fileKey(file: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? file.toLowerCase() : file;
}
