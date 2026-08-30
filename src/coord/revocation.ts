// Operator-override revocations (closes the boomerang window).
//
// When a collision is denied, the edit-hook offers `claim release --file <f>` as
// the escape hatch. That deletes the holder's claim outright — which frees the
// file for EVERYONE, not just the session the operator meant to unblock. The
// booted session is still live and still editing; whichever session touches the
// file next simply wins the `wx` create. If that's the booted session, it
// silently re-acquires and the OVERRIDER is now the one denied: the override
// reverses itself, and the operator has no idea.
//
// A revocation is the missing half of the override. Releasing the claim says
// "this file is free"; the revocation says "...but not for you, and here's why".
// It names the booted session and bars only that session for a short window,
// long enough for the intended session to take the file.
//
// Stored beside the claim it overrode, keyed by the same file hash but with a
// `.revoked` suffix, so every existing sweep (all of which filter on `.json`)
// ignores it. It is deliberately NOT written by `releaseFiles` — that is the
// ordinary "I'm done with this file" primitive used on commit and by the waiter
// tests, and barring anyone there would break normal FIFO handoff. Only the
// operator's explicit override writes one.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileKey } from './fileKey.js';

// How long an override is honored if the intended session never takes the file.
// Chosen to match the `.reap` orphan sweep window, a clock this store already
// reasons about. On lapse the bar simply expires and the booted session may
// re-acquire — an operator who overrode and walked away does not strand the file
// forever, which is the failure mode the TTL machinery exists to prevent. The
// trade is real: an override is NOT honored for the full length of a claim, so a
// booted session that stays quiet for 5 minutes can come back to the file.
export const REVOCATION_TTL_SEC = 300;

/** The `held_by` value reported when a claim is refused by a revocation. Deliberately
 *  not a session id: there is no holder on this path, and putting a fake one in a field
 *  every other record uses for a real session would surface a phantom session in the
 *  dashboard and the journal. */
export const OVERRIDE_HOLDER = '(operator override)';

export interface Revocation {
  file: string; // workspace-relative, forward-slashed
  revoked_session: string; // the session that was booted — only this one is barred
  revoked_at: string; // ISO
  ttl_sec: number;
}

const claimsDir = (root: string): string => join(root, '.repolith', 'claims');
const hashName = (file: string): string => createHash('sha256').update(fileKey(file)).digest('hex').slice(0, 16) + '.revoked';
const pathFor = (root: string, file: string): string => join(claimsDir(root), hashName(file));

const isFresh = (r: Revocation, nowMs: number): boolean => {
  const t = Date.parse(r.revoked_at);
  return !Number.isNaN(t) && nowMs - t < r.ttl_sec * 1000;
};

/** Record that `bootedSession` was overridden off `file`. Best-effort: a revocation that
 *  fails to write leaves today's behavior (a plain release), never a broken override. */
export async function writeRevocation(root: string, file: string, bootedSession: string, nowMs: number): Promise<void> {
  const rec: Revocation = {
    file,
    revoked_session: bootedSession,
    revoked_at: new Date(nowMs).toISOString(),
    ttl_sec: REVOCATION_TTL_SEC,
  };
  try {
    await mkdir(claimsDir(root), { recursive: true });
    await writeFile(pathFor(root, file), JSON.stringify(rec, null, 2) + '\n');
  } catch {
    /* advisory — an unwritable revocation must never break the release itself */
  }
}

/** The live revocation for `file`, or null. Expired records are swept on read: nothing
 *  else walks `.revoked` files, so this is where they get cleaned up. */
export async function readRevocation(root: string, file: string, nowMs: number): Promise<Revocation | null> {
  const p = pathFor(root, file);
  let rec: Revocation;
  try {
    rec = JSON.parse(await readFile(p, 'utf8')) as Revocation;
  } catch {
    return null; // absent, or unreadable/corrupt — never bar an edit on a record we can't read
  }
  if (!rec || typeof rec.revoked_session !== 'string') return null;
  if (isFresh(rec, nowMs)) return rec;
  await unlink(p).catch(() => {}); // lapsed — clear the bar
  return null;
}

/** Drop the bar for `file`. Called once the override has served its purpose (the intended
 *  session took the file), so a later, unrelated collision on the same file isn't refused
 *  by a stale override. */
export async function clearRevocation(root: string, file: string): Promise<void> {
  await unlink(pathFor(root, file)).catch(() => {});
}
