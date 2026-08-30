// `session-hook` — SessionStart hook: inject a workspace catch-up brief when a
// Claude Code session starts or resumes and coordination work is in flight.
// Silent on a quiet workspace (no active sessions, no held claims) — never nags.
//
// Verified payload shape (2026-06-29, claude-code-guide agent):
//   { session_id, cwd, source: 'startup'|'resume'|'clear'|'compact', ... }
// Output: hookSpecificOutput.additionalContext with hookEventName: 'SessionStart'.

import { readHookStdin } from './hook-stdin.js';
import { findManifestUp } from '../locate.js';
import { dirname } from 'node:path';
import { listActive, type SessionPlan } from '../coord/store.js';
import { listClaims, type Claim } from '../coord/claims.js';
import { cleanContext } from '../coord/sanitize.js';

interface SessionStartPayload {
  session_id?: string;
  cwd?: string;
  source?: string;
}

/** The catch-up brief for a workspace snapshot, or null on a quiet workspace.
 *  Pure — factored out of sessionHook so it's directly testable without faking hook
 *  stdin (same split as claimBashChanges in bash.ts). Store-sourced text (summaries,
 *  ids, files, areas) is cleaned at this injection sink — finding 10. */
export function renderSessionBrief(sessions: SessionPlan[], claims: Claim[]): string | null {
  if (!sessions.length && !claims.length) return null; // quiet workspace — stay silent

  const lines: string[] = ['🔄 repolith — workspace at a glance:'];

  if (sessions.length) {
    lines.push(`  ${sessions.length} active session(s):`);
    for (const s of sessions) {
      const top = s.areas.slice(0, 3).map((a) => cleanContext(a, 120)).join(', ');
      const more = s.areas.length > 3 ? `, +${s.areas.length - 3} more` : '';
      const areas = s.areas.length ? ` (${top}${more})` : '';
      lines.push(`    • ${cleanContext(s.session_id, 80)}: ${cleanContext(s.summary) || '(no summary)'}${areas}`);
    }
  }

  if (claims.length) {
    const shown = claims.slice(0, 8);
    lines.push(`  ${claims.length} active file claim(s):`);
    for (const c of shown) lines.push(`    • ${cleanContext(c.file, 200)}  ←  ${cleanContext(c.session_id, 80)}`);
    if (claims.length > 8) lines.push(`    … and ${claims.length - 8} more`);
  }

  lines.push('');
  lines.push('Run `repolith plan list` + `repolith claim list` for details.');
  return lines.join('\n');
}

export async function sessionHook(): Promise<void> {
  const raw = (await readHookStdin()).trim();
  if (!raw) return;
  let ev: SessionStartPayload;
  try {
    ev = JSON.parse(raw) as SessionStartPayload;
  } catch {
    return;
  }

  const manifestPath = await findManifestUp(ev.cwd || process.cwd());
  if (!manifestPath) return; // not a repolith workspace

  const root = dirname(manifestPath);
  const now = Date.now();
  const [sessions, claims] = await Promise.all([listActive(root, now), listClaims(root, now)]);

  const brief = renderSessionBrief(sessions, claims);
  if (!brief) return; // quiet workspace — stay silent

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: brief,
      },
    }),
  );
}
