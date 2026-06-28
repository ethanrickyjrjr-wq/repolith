import pLimit from 'p-limit';
import type { RepoEntry } from './types.js';

export type RepoResult<T> =
  | { repo: RepoEntry; ok: true; value: T }
  | { repo: RepoEntry; ok: false; error: Error };

export async function runAll<T>(
  repos: RepoEntry[],
  fn: (repo: RepoEntry) => Promise<T>,
  concurrency = Number(process.env['REPOLITH_CONCURRENCY'] ?? 8),
): Promise<RepoResult<T>[]> {
  const limit = pLimit(concurrency);
  return Promise.all(
    repos.map(repo =>
      limit(async () => {
        try {
          const value = await fn(repo);
          return { repo, ok: true as const, value };
        } catch (e: unknown) {
          return { repo, ok: false as const, error: e instanceof Error ? e : new Error(String(e)) };
        }
      }),
    ),
  );
}
