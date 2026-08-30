// Locate the workspace manifest by walking up from a starting directory.
//
// Public utility, shared by both trees: the interactive CLI commands resolve
// from process.cwd() and the coordination hooks resolve from the payload's
// `cwd` (never process.cwd()). Either way the rule is the same — walk up until
// a repolith.toml is found — so a command run from any repo *inside* the
// workspace lands on the workspace root, not on whatever directory it happened
// to be launched from.

import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function findManifestUp(
  startDir: string,
  filename = 'repolith.toml',
): Promise<string | null> {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, filename);
    try {
      await stat(candidate);
      return candidate;
    } catch {
      // not in this directory — keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolve the manifest path for an interactive CLI command.
 *
 * - An explicit `--manifest <path>` is honored but must exist. Commands that
 *   only `dirname()` the manifest to find the workspace root (the coordination
 *   commands: they read the `.repolith` store, never the toml itself) would
 *   otherwise silently derive a bogus root from a typo'd path and operate on an
 *   empty/wrong store with no error — the exact failure mode that made a stale
 *   claim look un-releasable. We stat it up front and fail loudly instead.
 * - With no explicit path, walk up from the current directory exactly like the
 *   hooks do, so `repolith claim list` (etc.) works from any repo inside the
 *   workspace, not only from the workspace root.
 */
export async function resolveManifest(explicit?: string): Promise<string> {
  if (explicit) {
    const p = resolve(explicit);
    try {
      await stat(p);
    } catch {
      throw new Error(`repolith: no manifest found at ${p} (from --manifest ${explicit}).`);
    }
    return p;
  }
  const found = await findManifestUp(process.cwd());
  if (!found) {
    throw new Error(
      `repolith: no repolith.toml found in ${process.cwd()} or any parent directory. ` +
        `Run from inside a repolith workspace, or pass --manifest <path>.`,
    );
  }
  return found;
}
