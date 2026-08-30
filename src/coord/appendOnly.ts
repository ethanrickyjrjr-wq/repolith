// Append-only file exemption for the edit-gate (claim.ts).
//
// A shared, high-frequency log (SESSION_LOG.md) is the worst fit for a whole-file
// exclusive claim released only on commit: independent appends don't conflict, but
// two sessions writing to the log every turn end up fighting over one long-held lock
// — whoever holds it releases at commit (which may be minutes away), and the loser's
// retry lands right after the holder's next append re-claims it. Exempting these
// files from the gate (never denied) fixes the fight without weakening the claim
// system for files that actually need mutual exclusion.
//
// Matched by basename, not glob — covers every repo's log with zero manifest config,
// and keeps the manifest parser dependency-free (smol-toml only, no glob library).

import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { parseManifest } from '../manifest.js';

const DEFAULT_APPEND_ONLY = new Set(['SESSION_LOG.md']);

/** Is `rel` exempt from the claim gate — always allowed, never denied?
 *  Best-effort: a missing or malformed manifest never blocks an edit, it just
 *  falls back to the built-in default list. */
export async function isAppendOnlyFile(root: string, rel: string): Promise<boolean> {
  const base = basename(rel);
  if (DEFAULT_APPEND_ONLY.has(base)) return true;
  try {
    const toml = await readFile(join(root, 'repolith.toml'), 'utf8');
    const manifest = parseManifest(toml);
    return (manifest.coord?.append_only ?? []).includes(base);
  } catch {
    return false;
  }
}
