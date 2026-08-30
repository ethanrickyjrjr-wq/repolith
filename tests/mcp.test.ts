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
