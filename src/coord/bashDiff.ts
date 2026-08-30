// Dirty-file fingerprinting for the Bash-bypass backstop (P1.5).
//
// The Edit/Write gate claims a file the moment it's touched, before the edit
// lands. Bash commands (sed -i, git checkout, codegen) mutate files with no
// tool_input.file_path to claim — the hook can't see WHAT changed until the
// command has already run. So this is reactive: bracket the call with a
// before/after snapshot of every dirty file across the workspace's repos,
// and treat whatever differs as "touched by this command".
//
// Fingerprint = git status code + mtime + size, not just the status code.
// A file another session already left dirty ("M") keeps the same code after
// a `sed -i` rewrite — code-only diffing would miss exactly the clobber this
// backstop exists to catch. mtime/size change on every write regardless.
//
// Symmetric diff, not "what's dirty now": a file flipping dirty→clean
// (`git checkout -- file` reverting someone's uncommitted edit) is also a
// P1.5 clobber, so disappearance from the dirty set counts as touched too.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkspaceManifest } from '../types.js';
import { gitRun } from '../git.js';
import { runAll } from '../runner.js';

export interface DirtyEntry {
  file: string; // workspace-relative, forward-slashed
  code: string; // git status --porcelain XY code
  mtimeMs: number;
  size: number;
}

const baselineDir = (root: string): string => join(root, '.repolith', 'bash-baseline');
const sessHash = (id: string): string => createHash('sha256').update(id).digest('hex').slice(0, 16);
const baselinePath = (root: string, sessionId: string): string => join(baselineDir(root), `${sessHash(sessionId)}.json`);

function parsePorcelain(output: string): { path: string; code: string }[] {
  const out: { path: string; code: string }[] = [];
  for (const line of output.split('\n')) {
    if (!line) continue;
    const code = line.slice(0, 2);
    let path = line.slice(3);
    const arrow = path.indexOf(' -> ');
    if (arrow !== -1) path = path.slice(arrow + 4); // rename/copy — the name on disk now
    if (path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1);
    if (path) out.push({ path, code });
  }
  return out;
}

/** Fingerprint every dirty (modified/staged/untracked) file across all repos in the manifest. */
export async function snapshotDirty(root: string, manifest: WorkspaceManifest): Promise<DirtyEntry[]> {
  const results = await runAll(manifest.repos, async (repo) => {
    const dest = join(root, repo.path);
    const { stdout } = await gitRun(dest, ['status', '--porcelain', '-uall']);
    const entries: DirtyEntry[] = [];
    for (const { path, code } of parsePorcelain(stdout)) {
      let mtimeMs = 0;
      let size = 0;
      try {
        const s = await stat(join(dest, path));
        mtimeMs = s.mtimeMs;
        size = s.size;
      } catch {
        /* deleted mid-race — 0/0 still distinguishes it from "absent" via the code */
      }
      entries.push({ file: join(repo.path, path).replace(/\\/g, '/'), code, mtimeMs, size });
    }
    return entries;
  });
  return results.flatMap((r) => (r.ok ? r.value : [])); // a repo git failure just contributes nothing — best-effort
}

/** Files whose fingerprint differs between two snapshots — added, removed, or changed. */
export function diffDirty(before: DirtyEntry[], after: DirtyEntry[]): string[] {
  const b = new Map(before.map((e) => [e.file, e]));
  const a = new Map(after.map((e) => [e.file, e]));
  const touched = new Set<string>();
  for (const [file, e] of a) {
    const prev = b.get(file);
    if (!prev || prev.code !== e.code || prev.mtimeMs !== e.mtimeMs || prev.size !== e.size) touched.add(file);
  }
  for (const file of b.keys()) {
    if (!a.has(file)) touched.add(file); // was dirty, now clean
  }
  return [...touched];
}

/** A dirty-set snapshot plus the wall-clock time it was taken at — the `ts` is what lets
 *  bash-post-hook ask "did the file's rightful holder act *during* my command's execution
 *  window", not just "is it dirty now". */
export interface BashBaseline {
  ts: number;
  dirty: DirtyEntry[];
}

/** The dirty-set snapshot taken before this session's most recent Bash call, or null if none yet
 *  (first Bash call this session, or the stored shape doesn't match — e.g. written by a prior
 *  version — either way treated as a cold start, never a hard error). */
export async function readBaseline(root: string, sessionId: string): Promise<BashBaseline | null> {
  try {
    const parsed = JSON.parse(await readFile(baselinePath(root, sessionId), 'utf8'));
    if (!parsed || typeof parsed.ts !== 'number' || !Array.isArray(parsed.dirty)) return null;
    return parsed as BashBaseline;
  } catch {
    return null;
  }
}

export async function writeBaseline(root: string, sessionId: string, ts: number, entries: DirtyEntry[]): Promise<void> {
  try {
    await mkdir(baselineDir(root), { recursive: true });
    const body: BashBaseline = { ts, dirty: entries };
    await writeFile(baselinePath(root, sessionId), JSON.stringify(body), 'utf8');
  } catch {
    /* advisory — swallow */
  }
}
