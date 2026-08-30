import { readFile } from 'node:fs/promises';
import { parse } from 'smol-toml';

// agentId -> toolName -> granted. Absent agent or absent tool = not granted.
export type GrantsConfig = Record<string, Record<string, boolean>>;

export function parseGrants(tomlString: string): GrantsConfig {
  const raw = parse(tomlString) as Record<string, unknown>;
  const agentsRaw = (raw['agents'] ?? {}) as Record<string, unknown>;
  const grants: GrantsConfig = {};
  for (const [agentId, entry] of Object.entries(agentsRaw)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`agents.${agentId} must be a table of tool = true/false`);
    }
    const tools: Record<string, boolean> = {};
    for (const [tool, value] of Object.entries(entry as Record<string, unknown>)) {
      if (typeof value !== 'boolean') {
        throw new Error(`agents.${agentId}.${tool} must be a boolean`);
      }
      tools[tool] = value;
    }
    grants[agentId] = tools;
  }
  return grants;
}

// No grants file = nobody has any grant. This is the safe default: a repolith mcp
// server started without --grants is read-only no matter what agent-id connects.
// An explicit --grants path that doesn't exist fails loudly rather than silently
// falling back to read-only, so a typo'd path can't be mistaken for "granted."
export async function loadGrants(path: string | undefined): Promise<GrantsConfig> {
  if (!path) return {};
  const text = await readFile(path, 'utf8');
  return parseGrants(text);
}

export function hasGrant(grants: GrantsConfig, agentId: string, tool: string): boolean {
  return grants[agentId]?.[tool] === true;
}
