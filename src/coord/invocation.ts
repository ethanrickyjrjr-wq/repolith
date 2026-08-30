// How was *this* repolith launched? The edit-gate deny message and `hooks
// install` both suggest commands a user (or agent) is meant to run — and those
// suggestions are worthless if they don't resolve. The published `repolith` bin
// (v0.3.x) has none of the coordination subcommands, so a from-source dogfood
// run must suggest `bun run <…/src/cli.ts> …`, not `repolith …`.
//
// We derive the prefix from process.argv: a source run is `bun run …/src/cli.ts`
// (argv[1] is a `.ts` path); an installed run is `dist/cli.js` behind the
// `repolith` launcher. `REPOLITH_BIN` overrides for anything the heuristic can't
// see (e.g. `node dist/cli.js` invoked directly, or an install path with /src/).
//
// Verified live 2026-06-28: a hook-spawned `bun run <abs>/src/cli.ts edit-hook`
// gives argv = [bun.exe, "<abs>/src/cli.ts", "edit-hook"].

/** The command prefix to put in front of a repolith subcommand in user-facing suggestions. */
export function selfInvocation(argv: string[] = process.argv, env: Record<string, string | undefined> = process.env): string {
  if (env.REPOLITH_BIN && env.REPOLITH_BIN.trim()) return env.REPOLITH_BIN.trim();
  const script = argv[1] ?? '';
  const norm = script.replace(/\\/g, '/'); // forward slashes: the verified-working hook-command form on Windows
  // Running from source under bun (`bun run …/src/cli.ts`) → suggest the same.
  if (norm.endsWith('.ts') || /(^|\/)src\/cli\.[cm]?js$/.test(norm)) return `bun run ${norm}`;
  return 'repolith'; // installed global bin (dist/cli.js via the `repolith` launcher)
}
