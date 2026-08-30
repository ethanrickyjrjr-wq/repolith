import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { syncCommand } from '../src/commands/sync';
import { buildMcpServer, type McpOptions } from '../src/mcp';
import { readAuditLog } from '../src/audit';

let remoteDir: string;
let wsDir: string;
let manifestPath: string;
const IDENTITY = ['-c', 'user.email=test@example.com', '-c', 'user.name=Test'];

beforeAll(async () => {
  remoteDir = await mkdtemp(join(tmpdir(), 'ws-mcp-remote-'));
  await execa('git', ['init', '--bare', remoteDir]);
  const tmp = await mkdtemp(join(tmpdir(), 'ws-mcp-tmp-'));
  await execa('git', ['clone', remoteDir, tmp]);
  await writeFile(join(tmp, 'app.ts'), '// TODO: wire it up\n');
  await execa('git', [...IDENTITY, 'add', '-A'], { cwd: tmp });
  await execa('git', [...IDENTITY, 'commit', '-m', 'init'], { cwd: tmp });
  await execa('git', ['push', 'origin', 'HEAD:main'], { cwd: tmp });
  await rm(tmp, { recursive: true });

  wsDir = await mkdtemp(join(tmpdir(), 'ws-mcp-ws-'));
  manifestPath = join(wsDir, 'repolith.toml');
  const url = remoteDir.replace(/\\/g, '/');
  await writeFile(manifestPath, [
    '[workspace]', 'name = "mcp-ws"', '',
    '[[repos]]', 'name = "hello"', `url = "${url}"`, 'path = "repos/hello"', 'ref = "main"', '',
  ].join('\n'));
  await syncCommand(manifestPath);
});

afterAll(async () => {
  await rm(remoteDir, { recursive: true });
  await rm(wsDir, { recursive: true });
});

let auditCounter = 0;
async function connect(opts: Partial<McpOptions> & { agentId: string }) {
  const auditPath = opts.auditPath ?? join(wsDir, `audit-${auditCounter++}.jsonl`);
  const server = await buildMcpServer(manifestPath, { ...opts, auditPath });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return {
    client,
    auditPath,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

const textOf = (res: { content: Array<{ text?: string }> }): string => res.content[0].text ?? '';

describe('repolith mcp server', () => {
  it('exposes read tools including the audit log, and hides checkout with no grants file', async () => {
    const { client, close } = await connect({ agentId: 'alice' });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('repolith_state');
      expect(names).toContain('repolith_status');
      expect(names).toContain('repolith_grep');
      expect(names).toContain('repolith_diff');
      expect(names).toContain('repolith_audit');
      expect(names).not.toContain('repolith_checkout');
    } finally {
      await close();
    }
  });

  it('repolith_state returns the atomic hash + pinned commit', async () => {
    const { client, close } = await connect({ agentId: 'alice' });
    try {
      const res = await client.callTool({ name: 'repolith_state', arguments: {} });
      const data = JSON.parse(textOf(res as never));
      expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(data.repos.hello.commit).toMatch(/^[0-9a-f]{40}$/);
    } finally {
      await close();
    }
  });

  it('repolith_grep finds matches grouped by repo', async () => {
    const { client, close } = await connect({ agentId: 'alice' });
    try {
      const res = await client.callTool({ name: 'repolith_grep', arguments: { pattern: 'TODO' } });
      const data = JSON.parse(textOf(res as never));
      expect(data[0].repo).toBe('hello');
      expect(data[0].hits.join('\n')).toContain('TODO');
    } finally {
      await close();
    }
  });

  it('exposes repolith_checkout only for an agent-id granted it in repolith.grants.toml', async () => {
    const grantsPath = join(wsDir, 'grants-mixed.toml');
    await writeFile(grantsPath, '[agents.alice]\ncheckout = true\n\n[agents.bob]\ncheckout = false\n', 'utf8');

    const alice = await connect({ agentId: 'alice', grantsPath });
    const bob = await connect({ agentId: 'bob', grantsPath });
    try {
      const aliceNames = (await alice.client.listTools()).tools.map((t) => t.name);
      const bobNames = (await bob.client.listTools()).tools.map((t) => t.name);
      expect(aliceNames).toContain('repolith_checkout');
      expect(bobNames).not.toContain('repolith_checkout');
    } finally {
      await alice.close();
      await bob.close();
    }
  });

  it('still hides checkout for an agent-id with a grants file that never mentions it', async () => {
    const grantsPath = join(wsDir, 'grants-empty.toml');
    await writeFile(grantsPath, '[agents.alice]\ncheckout = true\n', 'utf8');

    const { client, close } = await connect({ agentId: 'stranger', grantsPath });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('repolith_checkout');
    } finally {
      await close();
    }
  });

  it('records every tool call in the hash-chained audit log, tagged with this agent-id', async () => {
    const { client, close, auditPath } = await connect({ agentId: 'alice' });
    try {
      await client.callTool({ name: 'repolith_state', arguments: {} });
      await client.callTool({ name: 'repolith_grep', arguments: { pattern: 'TODO' } });

      const res = await client.callTool({ name: 'repolith_audit', arguments: {} });
      const data = JSON.parse(textOf(res as never));
      // repolith_audit reads the log as of just before its own call is appended.
      expect(data.verified).toBe(true);
      expect(data.entries).toBe(2);
      expect(data.log.every((e: { agentId: string }) => e.agentId === 'alice')).toBe(true);
      expect(data.log.map((e: { tool: string }) => e.tool)).toEqual(['repolith_state', 'repolith_grep']);

      const onDisk = await readAuditLog(auditPath);
      expect(onDisk).toHaveLength(3); // + the repolith_audit call itself
      expect(onDisk[2]!.tool).toBe('repolith_audit');
    } finally {
      await close();
    }
  });
});

describe('repolith plan-coordination tools', () => {
  it('exposes the coordination tools to any agent-id (no grant needed — they only touch .repolith/)', async () => {
    const { client, close } = await connect({ agentId: 'alice' });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('repolith_register_plan');
      expect(names).toContain('repolith_compare_plans');
      expect(names).toContain('repolith_list_active');
    } finally {
      await close();
    }
  });

  it('register_plan reports a hard conflict with another active session', async () => {
    const { client, close } = await connect({ agentId: 'alice' });
    try {
      await client.callTool({
        name: 'repolith_register_plan',
        arguments: { session_id: 'A', summary: 'owns assistant', areas: ['src/assistant/**'] },
      });
      const res = await client.callTool({
        name: 'repolith_register_plan',
        arguments: { session_id: 'B', summary: 'refactor dock', areas: ['src/assistant/dock.tsx'] },
      });
      const data = JSON.parse(textOf(res as never));
      expect(data.session_id).toBe('B');
      expect(data.clear).toBe(false);
      expect(data.conflicts[0].with_session).toBe('A');
      expect(data.conflicts[0].severity).toBe('hard');

      const listRes = await client.callTool({ name: 'repolith_list_active', arguments: {} });
      const active = JSON.parse(textOf(listRes as never)) as Array<{ session_id: string }>;
      const ids = active.map((p) => p.session_id);
      expect(ids).toContain('A');
      expect(ids).toContain('B');
    } finally {
      await close();
    }
  });

  it('compare_plans finds overlap against the active sessions (read-only)', async () => {
    const { client, close } = await connect({ agentId: 'alice' });
    try {
      // A and B from the previous test persist in the shared workspace store
      const res = await client.callTool({
        name: 'repolith_compare_plans',
        arguments: { session_id: 'probe', areas: ['src/assistant/panel.tsx'] },
      });
      const data = JSON.parse(textOf(res as never));
      expect(data.clear).toBe(false);
    } finally {
      await close();
    }
  });
});

describe('repolith edit-gate (claim) tools', () => {
  it('claim → check (held) → release → reclaim', async () => {
    const { client, close } = await connect({ agentId: 'alice' });
    try {
      const claimRes = await client.callTool({
        name: 'repolith_claim',
        arguments: { session_id: 'X', files: ['src/auth/session.ts'] },
      });
      expect(JSON.parse(textOf(claimRes as never)).results[0].status).toBe('new');

      const checkRes = await client.callTool({
        name: 'repolith_check',
        arguments: { session_id: 'Y', files: ['src/auth/session.ts'] },
      });
      const checkData = JSON.parse(textOf(checkRes as never));
      expect(checkData.held).toHaveLength(1);
      expect(checkData.held[0].held_by).toBe('X');

      const listRes = await client.callTool({ name: 'repolith_list_claims', arguments: {} });
      const claims = JSON.parse(textOf(listRes as never)) as Array<{ file: string }>;
      expect(claims.some((c) => c.file === 'src/auth/session.ts')).toBe(true);

      const relRes = await client.callTool({
        name: 'repolith_release',
        arguments: { session_id: 'X', files: ['src/auth/session.ts'] },
      });
      expect(JSON.parse(textOf(relRes as never)).released).toBe(1);

      // released → Y can now claim it
      const yClaim = await client.callTool({
        name: 'repolith_claim',
        arguments: { session_id: 'Y', files: ['src/auth/session.ts'] },
      });
      expect(JSON.parse(textOf(yClaim as never)).results[0].status).toBe('new');
    } finally {
      await close();
    }
  });
});
