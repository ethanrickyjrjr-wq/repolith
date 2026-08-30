// Best-effort snapshot push — keeps the deployed /coord dashboard live.
//
// The coordination hooks call this right after they mutate the store (a claim, a
// deny, a commit-release, a plan). It throttles via a shared lock file, then runs
// the upload and AWAITS it. The actual work — build the snapshot, resolve the
// token, upload to Vercel Blob — is reused verbatim from scripts/coord-push.ps1
// (one source of truth).
//
// Why awaited, not fire-and-forget: a detached child does NOT reliably survive the
// Bun hook process exiting on Windows (verified 2026-06-30 — `detached:true` and
// `cmd /c start /b` both dropped the upload intermittently). So we await, bounded by
// a kill-timeout, and lean on the throttle to keep blocking rare.
//
// Throttle policy (the asymmetry matters): claims are long-lived ("who's editing
// what"), so a 20s lag on the dashboard is invisible — throttle them generously so
// editing isn't paced by uploads. Deny/commit/release are the urgent, low-frequency
// signals (collisions, settled state) — push those promptly so phantoms clear and
// collisions surface fast.
//
// Windows-only by design: this feature is deployed on a Windows dev machine and
// coord-push.ps1 is PowerShell. On other platforms this is a safe no-op; the manual
// `scripts/coord-push.ps1` (or a future cross-platform uploader) covers them.
//
// The uploader script is SITE-SPECIFIC and not shipped with the package (it knows
// where one particular dashboard lives and how to find its token). When it is
// absent — every fresh clone and every npm install — this is a silent no-op, so the
// hooks never pay a PowerShell spawn for a dashboard that isn't configured.

import { spawn } from 'node:child_process';
import { stat, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Default throttle for high-frequency claims — a few seconds' dashboard lag is invisible for long-lived claims. */
export const PUSH_THROTTLE_MS = 20000;
/** Throttle for urgent/low-frequency events (deny, commit, release) — clears phantoms / surfaces collisions fast. */
export const PUSH_URGENT_MS = 3000;
/** Hard cap on how long the upload may block a hook (a hung vercel CLI must not blow the hook's timeout budget). */
const UPLOAD_TIMEOUT_MS = 8000;

const SCRIPT = fileURLToPath(new URL('../../scripts/coord-push.ps1', import.meta.url));

/** Test seams (finding 11): inject a fake spawn / short timeout so the throttle, kill,
 *  and error paths are testable without PowerShell or a live Blob upload. Production
 *  callers pass nothing and get the real spawn + UPLOAD_TIMEOUT_MS. */
export interface PushDeps {
  spawnFn?: typeof spawn;
  timeoutMs?: number;
  /** Uploader script to run (default: scripts/coord-push.ps1 next to the source). Tests point
   *  this at any existing file so the presence check passes without the real script. */
  scriptPath?: string;
}

/**
 * Throttled, awaited, best-effort upload of the coord snapshot to Vercel Blob.
 * Never throws. Blocks the calling hook only on a throttle-boundary fire, and never
 * for longer than UPLOAD_TIMEOUT_MS. A skipped or failed push is self-healing: the
 * next coordination event pushes the settled state.
 *
 * @param root        workspace root (dir holding `.repolith`)
 * @param throttleMs  minimum gap since the last push for this call to fire
 */
export async function pushSnapshot(root: string, throttleMs: number = PUSH_THROTTLE_MS, deps: PushDeps = {}): Promise<void> {
  const spawnFn = deps.spawnFn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  // Opt-out for tests/CI — a hook driven through its real entry point must not fire a
  // live Vercel Blob upload. Any non-empty value disables the push.
  if (process.env['REPOLITH_NO_SNAPSHOT_PUSH']) return;
  if (process.platform !== 'win32') return; // PowerShell uploader — Windows only
  const script = deps.scriptPath ?? SCRIPT;
  try {
    await stat(script); // no uploader configured on this machine → nothing to do
  } catch {
    return;
  }
  try {
    const storeDir = join(root, '.repolith');
    const lock = join(storeDir, '.blob-push-ts');
    try {
      const s = await stat(lock);
      if (Date.now() - s.mtimeMs < throttleMs) return; // pushed recently — skip
    } catch {
      /* no lock yet → first push */
    }
    // Claim the window before running so concurrent hooks don't all fire at once.
    await mkdir(storeDir, { recursive: true }).catch(() => {});
    await writeFile(lock, new Date().toISOString(), 'utf8').catch(() => {});

    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        const child = spawnFn(
          'powershell',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script],
          { stdio: 'ignore', windowsHide: true },
        );
        const timer = setTimeout(() => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
          finish();
        }, timeoutMs);
        child.once('exit', () => {
          clearTimeout(timer);
          finish();
        });
        child.once('error', () => {
          clearTimeout(timer);
          finish();
        });
      } catch {
        finish();
      }
    });
  } catch {
    /* advisory — a failed push must never break a hook */
  }
}
