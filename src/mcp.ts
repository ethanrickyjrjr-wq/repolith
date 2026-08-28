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
import { loadGrants, hasGrant } from './grants.js';
import { appendAuditEntry, readAuditLog, verifyAuditLog } from './audit.js';
import type { LockRepo } from './types.js';

export interface McpOptions {
  /** Identity of the agent/session running this server process. Recorded on every audit entry. */
  agentId: string;
  /** Path to a repolith.grants.toml granting this agent-id write capabilities. Omit = read-only. */
  grantsPath?: string;
  /** Path to the append-only, hash-chained audit log. Defaults to repolith.audit.jsonl next to the manifest. */
  auditPath?: string;
}

type ToolResult = { content: { type: 'text'; text: string }[] };

const jsonResult = (data: unknown): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
});

/**
 * Build the repolith MCP server. Read tools (state/status/grep/diff/audit) are always
 * registered; the mutating `repolith_checkout` tool is only registered when the calling
 * agent-id has a `checkout = true` grant in repolith.grants.toml. Every tool call — read
 * or write, success or failure — is appended to the hash-chained audit log tagged with
 * this server's agent-id, so "who did what" survives even for read-only reconnaissance.
 * No tool writes to stdout (it is the JSON-RPC channel for the stdio transport).
 */
export async function buildMcpServer(manifestPath: string, opts: McpOptions): Promise<McpServer> {
  const manifestDir = resolve(manifestPath, '..');
  const auditPath = opts.auditPath ?? join(manifestDir, 'repolith.audit.jsonl');
  const grants = await loadGrants(opts.grantsPath);
  const server = new McpServer({ name: 'repolith', version: '0.3.1' });
  const loadManifest = async () => parseManifest(await readFile(manifestPath, 'utf8'));

  function audited<A>(
    tool: string,
    summarize: (args: A) => unknown,
    handler: (args: A) => Promise<ToolResult>,
  ) {
    return async (args: A): Promise<ToolResult> => {
      try {
        const result = await handler(args);
        await appendAuditEntry(auditPath, {
          ts: new Date().toISOString(),
          agentId: opts.agentId,
          tool,
          args: summarize(args),
          ok: true,
        });
        return result;
      } catch (e) {
        await appendAuditEntry(auditPath, {
          ts: new Date().toISOString(),
          agentId: opts.agentId,
          tool,
          args: summarize(args),
          ok: false,
          error: (e as Error).message,
        });
        throw e;
      }
    };
  }

  // READ — the deterministic system fingerprint
  server.registerTool(
    'repolith_state',
    {
      title: 'Workspace state',
      description:
        "The atomic workspace hash plus each repo's current commit — the deterministic fingerprint of the whole multi-repo system.",
    },
    audited('repolith_state', () => ({}), async () => {
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
    }),
  );

  // READ — structured status
  server.registerTool(
    'repolith_status',
    {
      title: 'Repo status',
      description: 'Branch, dirty/clean, and ahead/behind counts for every repo.',
    },
    audited('repolith_status', () => ({}), async () => {
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
    }),
  );

  // READ — cross-repo grep
  server.registerTool(
    'repolith_grep',
    {
      title: 'Search across repos',
      description: 'Search a regex across every repo. Returns matches grouped by repo.',
      inputSchema: { pattern: z.string().describe('Pattern passed to git grep') },
    },
    audited(
      'repolith_grep',
      (args: { pattern: string }) => ({ pattern: args.pattern }),
      async ({ pattern }: { pattern: string }) => {
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
    ),
  );

  // READ — per-repo working-tree diff
  server.registerTool(
    'repolith_diff',
    {
      title: 'Diff across repos',
      description: 'Working-tree diff for every repo (empty string when clean).',
    },
    audited('repolith_diff', () => ({}), async () => {
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
    }),
  );

  // READ — the audit trail itself, always available so any agent (or human) can see
  // who has done what, and whether the log's hash chain still verifies intact.
  server.registerTool(
    'repolith_audit',
    {
      title: 'Audit log',
      description:
        'The append-only, hash-chained log of every repolith MCP tool call against this workspace so far, plus whether the chain still verifies. Reflects state as of just before this call.',
    },
    audited('repolith_audit', () => ({}), async () => {
      const log = await readAuditLog(auditPath);
      const verify = await verifyAuditLog(auditPath);
      return jsonResult({ verified: verify.ok, entries: verify.entries, brokenAtLine: verify.brokenAtLine, log });
    }),
  );

  // WRITE (gated) — restore the whole system to the locked state. Only registered
  // for an agent-id with an explicit `checkout = true` grant in repolith.grants.toml.
  if (hasGrant(grants, opts.agentId, 'checkout')) {
    server.registerTool(
      'repolith_checkout',
      {
        title: 'Restore locked state',
        description:
          'Restore every repo to the commit pinned in repolith.lock.json (deterministic system checkout). Mutates working trees. Requires a checkout grant for this agent-id.',
      },
      audited('repolith_checkout', () => ({}), async () => jsonResult(await restoreToLock(manifestPath))),
    );
  }

  return server;
}

export async function startMcpServer(manifestPath: string, opts: McpOptions): Promise<void> {
  const server = await buildMcpServer(manifestPath, opts);
  await server.connect(new StdioServerTransport());
}
