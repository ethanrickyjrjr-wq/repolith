import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Lockfile, LockRepo } from './types.js';

const LOCK_FILENAME = 'repolith.lock.json';

export function computeHash(repos: Record<string, LockRepo>): string {
  const lines = Object.entries(repos)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, r]) => `${name}:${r.commit}`)
    .join('\n');
  return createHash('sha256').update(lines).digest('hex');
}

export async function readLockfile(dir: string): Promise<Lockfile | null> {
  try {
    const text = await readFile(join(dir, LOCK_FILENAME), 'utf8');
    return JSON.parse(text) as Lockfile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeLockfile(dir: string, lock: Lockfile): Promise<void> {
  await writeFile(join(dir, LOCK_FILENAME), JSON.stringify(lock, null, 2) + '\n', 'utf8');
}
