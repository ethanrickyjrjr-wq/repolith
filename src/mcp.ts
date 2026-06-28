import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseManifest } from './manifest.js';
import { computeHash } from './lockfile.js';
import { gitRun } from './git.js';
import { runAll } from './runner.js';
import { restoreToLock } from './commands/checkout.js';
import type { LockRepo } from './types.js';

export interface McpOptions {
  /** Expose mutating tools (repolith_checkout). Off by default. */
  allowWrite: boolean;
}

const jsonResult = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * Build the repolith MCP server. Read tools are always registered; the mutating
 * `repolith_checkout` tool is only registered when `allowWrite` is true. No tool
 * writes to stdout (it is the JSON-RPC channel for the stdio transport).
 */
export function buildMcpServer(manifestPath: string, opts: McpOptions): McpServer {
  const manifestDir = resolve(manifestPath, '..');
  const server = new McpServer({ name: 'repolith', version: '0.3.0' });
  const loadManifest = async () => parseManifest(await readFile(manifestPath, 'utf8'));

  // READ — the deterministic system fingerprint
  server.registerTool(
    'repolith_state',
    {
      title: 'Workspace state',
      description:
        "The atomic workspace hash plus each repo's current commit — the deterministic fingerprint of the whole multi-repo system.",
    },
    async () => {
      const manifest = await loadManifest();
      const results = await runAll(manifest.repos, async (repo) => {
        const { stdout } = await gitRun(join(manifestDir, repo.path), ['rev-parse', 'HEAD']);
        return stdout.trim();
      });
      const repos: Record<string, LockRepo> = {};
      for (const r of results) {
        if (r.ok) repos[r.repo.name] = { url: r.repo.url, ref: r.repo.ref, commit: r.value };
      }
      return jsonResult({ workspace: manifest.name, hash: computeHash(repos), repos });
    },
  );

  // READ — structured status
  server.registerTool(
    'repolith_status',
    {
      title: 'Repo status',
      description: 'Branch, dirty/clean, and ahead/behind counts for every repo.',
    },
    async () => {
      const manifest = await loadManifest();
      const results = await runAll(manifest.repos, async (repo) => {
        const dest = join(manifestDir, repo.path);
        const branch = (await gitRun(dest, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
        const dirty = (await gitRun(dest, ['status', '--porcelain'])).stdout.trim().length > 0;
        let ahead = 0;
        let behind = 0;
        try {
          const { stdout } = await gitRun(dest, ['rev-list', '--left-right', '--count', '@{u}...HEAD']);
          const [b, a] = stdout.trim().split(/\s+/).map(Number);
          behind = b || 0;
          ahead = a || 0;
        } catch {
          // no upstream tracking branch
        }
        return { branch, dirty, ahead, behind };
      });
      return jsonResult(
        results.map((r) =>
          r.ok ? { repo: r.repo.name, ...r.value } : { repo: r.repo.name, error: r.error.message },
        ),
      );
    },
  );

  // READ — cross-repo grep
  server.registerTool(
    'repolith_grep',
    {
      title: 'Search across repos',
      description: 'Search a regex across every repo. Returns matches grouped by repo.',
      inputSchema: { pattern: z.string().describe('Pattern passed to git grep') },
    },
    async ({ pattern }) => {
      const manifest = await loadManifest();
      const results = await runAll(manifest.repos, async (repo) => {
        const { stdout } = await gitRun(join(manifestDir, repo.path), ['grep', '-n', '--color=never', pattern])
          .catch(() => ({ stdout: '', stderr: '' }));
        return stdout;
      });
      const matches: { repo: string; hits: string[] }[] = [];
      for (const r of results) {
        if (r.ok && r.value.trim()) matches.push({ repo: r.repo.name, hits: r.value.trim().split('\n') });
      }
      return jsonResult(matches);
    },
  );

  // READ — per-repo working-tree diff
  server.registerTool(
    'repolith_diff',
    {
      title: 'Diff across repos',
      description: 'Working-tree diff for every repo (empty string when clean).',
    },
    async () => {
      const manifest = await loadManifest();
      const results = await runAll(manifest.repos, async (repo) => {
        const { stdout } = await gitRun(join(manifestDir, repo.path), ['diff']);
        return stdout;
      });
      return jsonResult(
        results.map((r) =>
          r.ok ? { repo: r.repo.name, diff: r.value } : { repo: r.repo.name, error: r.error.message },
        ),
      );
    },
  );

  // WRITE (gated) — restore the whole system to the locked state
  if (opts.allowWrite) {
    server.registerTool(
      'repolith_checkout',
      {
        title: 'Restore locked state',
        description:
          'Restore every repo to the commit pinned in repolith.lock.json (deterministic system checkout). Mutates working trees.',
      },
      async () => jsonResult(await restoreToLock(manifestPath)),
    );
  }

  return server;
}

export async function startMcpServer(manifestPath: string, opts: McpOptions): Promise<void> {
  const server = buildMcpServer(manifestPath, opts);
  await server.connect(new StdioServerTransport());
}
