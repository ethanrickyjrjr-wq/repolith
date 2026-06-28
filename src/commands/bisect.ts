import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execa } from 'execa';
import { parseManifest } from '../manifest.js';
import { gitRun, gitCurrentCommit, gitCheckoutCommit } from '../git.js';
import type { Lockfile } from '../types.js';

export interface TimelinePoint {
  repo: string;
  commit: string;
  when: string;    // committer date, ISO
  author: string;
  subject: string;
}

export interface BisectOptions {
  manifestPath: string;
  goodLockPath: string; // a known-good repolith.lock.json
  test: string;         // shell command; exit 0 = good, non-zero = bad
}

export interface BisectResult {
  culprit: TimelinePoint | null;
  steps: number;          // number of test runs during the search
  timelineLength: number; // candidate commits considered
}

const SEP = '\x1f';

// Cross-repo bisect. "good" = the commits in goodLock; "bad" = current HEADs.
// Builds the merged timeline of commits introduced in each repo's good..HEAD range
// (sorted by committer date) and binary-searches for the first combined state that
// fails `test`. Pure: returns data, never prints. Restores repos to their starting
// HEADs before returning. Conservative v1: assumes the failure is monotonic and
// treats any non-zero exit (incl. build breakage) as "bad" — it finds *a* breaking
// point, not a provably-minimal one.
export async function bisect(opts: BisectOptions): Promise<BisectResult> {
  const manifestDir = resolve(opts.manifestPath, '..');
  const manifest = parseManifest(await readFile(opts.manifestPath, 'utf8'));
  const goodLock = JSON.parse(await readFile(opts.goodLockPath, 'utf8')) as Lockfile;

  const pathOf: Record<string, string> = {};
  const goodCommitOf: Record<string, string> = {};
  const originalHead: Record<string, string> = {};
  const timeline: TimelinePoint[] = [];

  for (const repo of manifest.repos) {
    const dest = join(manifestDir, repo.path);
    pathOf[repo.name] = dest;
    const g = goodLock.repos[repo.name]?.commit;
    if (!g) throw new Error(`good lockfile has no commit for "${repo.name}"`);
    goodCommitOf[repo.name] = g;
    const head = await gitCurrentCommit(dest);
    originalHead[repo.name] = head;
    if (head === g) continue; // no candidates in this repo
    const { stdout } = await gitRun(dest, [
      'log', '--reverse', `--format=%H${SEP}%cI${SEP}%an${SEP}%s`, `${g}..${head}`,
    ]);
    for (const line of stdout.split('\n')) {
      if (!line.trim()) continue;
      const [commit, when, author, subject] = line.split(SEP);
      timeline.push({ repo: repo.name, commit, when, author, subject });
    }
  }

  timeline.sort((a, b) => a.when.localeCompare(b.when));
  const N = timeline.length;

  // Combined state at step k: each repo at its newest timeline commit within [0..k-1],
  // else its good commit.
  const stateAt = (k: number): Record<string, string> => {
    const state = { ...goodCommitOf };
    for (let i = 0; i < k; i++) state[timeline[i].repo] = timeline[i].commit;
    return state;
  };

  const applyAndTest = async (k: number): Promise<boolean> => {
    const state = stateAt(k);
    for (const [name, commit] of Object.entries(state)) {
      await gitCheckoutCommit(pathOf[name], commit);
    }
    const r = await execa(opts.test, { cwd: manifestDir, shell: true, reject: false });
    return (r.exitCode ?? 0) === 0; // true = passed (good)
  };

  try {
    if (N === 0) return { culprit: null, steps: 0, timelineLength: 0 };

    let steps = 0;
    steps++;
    if (!(await applyAndTest(0))) {
      throw new Error('test already fails at the --good state — choose an earlier good point');
    }
    steps++;
    if (await applyAndTest(N)) {
      throw new Error('test passes at the current state — nothing to bisect');
    }

    let lo = 0; // known good
    let hi = N; // known bad
    while (hi - lo > 1) {
      const mid = Math.floor((lo + hi) / 2);
      steps++;
      if (await applyAndTest(mid)) lo = mid;
      else hi = mid;
    }
    return { culprit: timeline[hi - 1], steps, timelineLength: N };
  } finally {
    for (const [name, commit] of Object.entries(originalHead)) {
      await gitCheckoutCommit(pathOf[name], commit).catch(() => {});
    }
  }
}
