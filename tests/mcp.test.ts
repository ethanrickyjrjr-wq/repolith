import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { syncCommand } from '../src/commands/sync';
import { buildMcpServer, type McpOptions } from '../src/mcp';

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

async function connect(opts: McpOptions) {
  const server = buildMcpServer(manifestPath, opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return { client, close: async () => { await client.close(); await server.close(); } };
}

const textOf = (res: { content: Array<{ text?: string }> }): string => res.content[0].text ?? '';

describe('repolith mcp server', () => {
  it('exposes read tools and hides checkout without --allow-write', async () => {
    const { client, close } = await connect({ allowWrite: false });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('repolith_state');
      expect(names).toContain('repolith_status');
      expect(names).toContain('repolith_grep');
      expect(names).toContain('repolith_diff');
      expect(names).not.toContain('repolith_checkout');
    } finally {
      await close();
    }
  });

  it('repolith_state returns the atomic hash + pinned commit', async () => {
    const { client, close } = await connect({ allowWrite: false });
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
    const { client, close } = await connect({ allowWrite: false });
    try {
      const res = await client.callTool({ name: 'repolith_grep', arguments: { pattern: 'TODO' } });
      const data = JSON.parse(textOf(res as never));
      expect(data[0].repo).toBe('hello');
      expect(data[0].hits.join('\n')).toContain('TODO');
    } finally {
      await close();
    }
  });

  it('exposes repolith_checkout when --allow-write is set', async () => {
    const { client, close } = await connect({ allowWrite: true });
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('repolith_checkout');
    } finally {
      await close();
    }
  });
});
