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
import { writePlan, listActive, type SessionPlan } from './coord/store.js';
import { claimFile, checkFile, releaseFiles, releaseSession, listClaims, type ClaimOutcome } from './coord/claims.js';
import { REVOCATION_TTL_SEC } from './coord/revocation.js';

// An override refusal has no holder — `held_by` reads `(operator override)` by design. The
// hook path explains that in its deny message; MCP clients get the raw outcome, so without
// this a model sees a holder that isn't a session and tries to negotiate with a phantom.
// Additive: every existing field is preserved, only `reason` is attached.
function explainOutcome(o: ClaimOutcome): ClaimOutcome | (ClaimOutcome & { reason: string }) {
  if (o.ok || !o.revoked) return o;
  return {
    ...o,
    reason:
      `Your claim on this file was force-released by the operator, because another session was waiting on it. ` +
      `There is no current holder to wait for — "${o.held_by}" is a marker, not a session. ` +
      `That other session may be editing the file right now: re-read it before touching it again, your copy is likely stale. ` +
      `The bar lifts automatically ${REVOCATION_TTL_SEC / 60} min after the override.`,
  };
}
import { waitForClaim } from './coord/waits.js';
import { extractAreas, firstLine } from './coord/extract.js';
import { compareAgainstActive } from './coord/overlap.js';
import { renderSemanticCheck } from './coord/semantic.js';
import { loadGrants, hasGrant } from './grants.js';
import { appendAuditEntry, readAuditLog, verifyAuditLog } from './audit.js';
import type { LockRepo } from './types.js';

// Arg shapes for the coordination tools (mirror their zod inputSchemas) so audited() can type them.
interface RegisterArgs { summary?: string; areas?: string[]; plan?: string; session_id?: string; ttl_sec?: number }
interface CompareArgs { areas?: string[]; plan?: string; session_id?: string }
interface FilesArgs { files: string[]; session_id?: string }
interface ReleaseArgs { files?: string[]; session_id?: string }
interface WaitArgs { file: string; session_id?: string; timeout_sec?: number }

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
  const server = new McpServer({ name: 'repolith', version: '0.4.0' });
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

  // COORDINATION — register this session's plan + report conflicts with other
  // active sessions. Touches only `.repolith/` (never a git working tree), so —
  // unlike repolith_checkout — these are registered by default, not gated.
  server.registerTool(
    'repolith_register_plan',
    {
      title: "Register this session's plan",
      description:
        "Record this session's plan + blast radius (writes coordination state under .repolith/) and report path-overlap conflicts with other active sessions. Also returns `semantic_check`: a prompt to judge coupling path-overlap can't see (a symbol you rename that another session calls, a signature/type/contract you change that it depends on) — read it and decide before editing. Call right after planning, before editing.",
      inputSchema: {
        summary: z.string().optional().describe('One-line summary of the plan'),
        areas: z
          .array(z.string())
          .optional()
          .describe('Globs/paths you expect to touch (best signal). If omitted, extracted from `plan`.'),
        plan: z.string().optional().describe('Plan markdown; used to extract areas + summary when `areas` is absent.'),
        session_id: z.string().optional().describe('Stable id for this session (defaults to a per-process id).'),
        ttl_sec: z.number().optional().describe('Seconds before this registration goes stale (default 3600).'),
      },
    },
    audited('repolith_register_plan', (a: RegisterArgs) => ({ summary: a.summary, areas: a.areas, session_id: a.session_id }), async ({ summary, areas, plan, session_id, ttl_sec }: RegisterArgs) => {
      const manifest = await loadManifest();
      const id = session_id ?? `mcp-${process.pid}`;
      const resolvedAreas = areas?.length ? areas : extractAreas(plan);
      const now = new Date().toISOString();
      const me: SessionPlan = {
        session_id: id,
        workspace: manifest.name,
        summary: summary ?? firstLine(plan),
        areas: resolvedAreas,
        status: 'planning',
        plan_excerpt: (plan ?? '').slice(0, 800),
        started_at: now,
        updated_at: now,
        ttl_sec: ttl_sec ?? 3600,
      };
      await writePlan(manifestDir, me);
      const others = await listActive(manifestDir, Date.now());
      return jsonResult({
        session_id: id,
        areas: resolvedAreas,
        ...compareAgainstActive(me, others),
        semantic_check: renderSemanticCheck(me, others), // Phase 3 — coupling path-overlap can't see; null when alone
      });
    }),
  );

  server.registerTool(
    'repolith_compare_plans',
    {
      title: 'Compare a plan against active sessions',
      description:
        'Path-overlap conflict check for given areas/plan against every other active session (no write). Also returns `semantic_check` — a prompt to judge coupling path-overlap misses (rename/signature/interface/contract dependencies between your plan and theirs).',
      inputSchema: {
        areas: z.array(z.string()).optional(),
        plan: z.string().optional(),
        session_id: z.string().optional().describe('Exclude this session id from the comparison.'),
      },
    },
    audited('repolith_compare_plans', (a: CompareArgs) => ({ areas: a.areas, session_id: a.session_id }), async ({ areas, plan, session_id }: CompareArgs) => {
      const me = {
        session_id: session_id ?? 'probe',
        summary: firstLine(plan),
        areas: areas?.length ? areas : extractAreas(plan),
        plan_excerpt: (plan ?? '').slice(0, 800),
      };
      const others = await listActive(manifestDir, Date.now());
      return jsonResult({
        ...compareAgainstActive(me, others),
        semantic_check: renderSemanticCheck(me, others),
      });
    }),
  );

  server.registerTool(
    'repolith_list_active',
    {
      title: 'List active planning sessions',
      description: 'Active (non-stale) sessions and their declared blast radius.',
    },
    audited('repolith_list_active', () => ({}), async () => jsonResult(await listActive(manifestDir, Date.now()))),
  );

  // COORDINATION — file claims (the edit-gate backstop). claim-on-first-touch:
  // claiming a file blocks other live sessions from editing it until release/TTL.
  const normRel = (f: string): string => f.replace(/\\/g, '/');

  server.registerTool(
    'repolith_claim',
    {
      title: 'Claim files for editing',
      description:
        'Reserve one or more files (workspace-relative paths) so other live sessions are blocked from editing them. Writes to .repolith/. Returns per-file outcome: new | renewed | took-over | held (held = another session has it).',
      inputSchema: {
        files: z.array(z.string()).describe('Workspace-relative file paths to claim'),
        session_id: z.string().optional(),
      },
    },
    audited('repolith_claim', (a: FilesArgs) => ({ files: a.files, session_id: a.session_id }), async ({ files, session_id }: FilesArgs) => {
      const id = session_id ?? `mcp-${process.pid}`;
      const now = Date.now();
      const results = [];
      for (const f of files) results.push(explainOutcome(await claimFile(manifestDir, normRel(f), id, now)));
      return jsonResult({ session_id: id, results });
    }),
  );

  server.registerTool(
    'repolith_check',
    {
      title: 'Check files for conflicting claims',
      description: 'Non-mutating: which of these files are currently held by another live session.',
      inputSchema: {
        files: z.array(z.string()),
        session_id: z.string().optional(),
      },
    },
    audited('repolith_check', (a: FilesArgs) => ({ files: a.files, session_id: a.session_id }), async ({ files, session_id }: FilesArgs) => {
      const id = session_id ?? `mcp-${process.pid}`;
      const now = Date.now();
      const results = [];
      for (const f of files) results.push(explainOutcome(await checkFile(manifestDir, normRel(f), id, now)));
      return jsonResult({ session_id: id, results, held: results.filter((r) => !r.ok) });
    }),
  );

  server.registerTool(
    'repolith_release',
    {
      title: 'Release file claims',
      description: 'Release your claims — specific `files`, or all of this session_id when `files` is omitted.',
      inputSchema: {
        files: z.array(z.string()).optional(),
        session_id: z.string().optional(),
      },
    },
    audited('repolith_release', (a: ReleaseArgs) => ({ files: a.files, session_id: a.session_id }), async ({ files, session_id }: ReleaseArgs) => {
      const id = session_id ?? `mcp-${process.pid}`;
      const released = files?.length
        ? await releaseFiles(manifestDir, files.map(normRel), id)
        : await releaseSession(manifestDir, id);
      return jsonResult({ released });
    }),
  );

  server.registerTool(
    'repolith_list_claims',
    {
      title: 'List active file claims',
      description: 'Every active (non-stale) file claim and which session holds it.',
    },
    audited('repolith_list_claims', () => ({}), async () => jsonResult(await listClaims(manifestDir, Date.now()))),
  );

  server.registerTool(
    'repolith_wait_claim',
    {
      title: 'Wait for and acquire a file claim (auto-resume)',
      description:
        'Block until a file is free (or already yours), then claim it and return — auto-resumes the moment the holder releases (e.g. on commit). Returns {acquired, reason}: reason "deadlock" means you and the holder each hold a file the other needs and you were elected to yield (one member of the cycle keeps waiting) — release a file you hold or re-scope, and the other session proceeds; "timeout" means it stayed held.',
      inputSchema: {
        file: z.string().describe('Workspace-relative file path to wait for'),
        session_id: z.string().optional(),
        timeout_sec: z.number().optional().describe('Max seconds to block (default 120)'),
      },
    },
    audited('repolith_wait_claim', (a: WaitArgs) => ({ file: a.file, session_id: a.session_id, timeout_sec: a.timeout_sec }), async ({ file, session_id, timeout_sec }: WaitArgs) => {
      const id = session_id ?? `mcp-${process.pid}`;
      const res = await waitForClaim(manifestDir, normRel(file), id, { timeoutMs: (timeout_sec ?? 120) * 1000 });
      return jsonResult({ session_id: id, ...res });
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
