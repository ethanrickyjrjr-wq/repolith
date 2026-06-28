import { parse } from 'smol-toml';
import type { WorkspaceManifest, RepoEntry } from './types.js';

export function parseManifest(tomlString: string): WorkspaceManifest {
  const raw = parse(tomlString) as Record<string, unknown>;

  const ws = raw['workspace'] as Record<string, unknown> | undefined;
  if (!ws || typeof ws['name'] !== 'string') {
    throw new Error('workspace.name is required and must be a string');
  }

  const rawRepos = raw['repos'];
  if (!Array.isArray(rawRepos)) {
    throw new Error('At least one [[repos]] entry is required');
  }

  const names = new Set<string>();
  const repos: RepoEntry[] = rawRepos.map((r: unknown, i: number) => {
    const repo = r as Record<string, unknown>;
    for (const field of ['name', 'url', 'path', 'ref']) {
      if (typeof repo[field] !== 'string') {
        throw new Error(`repos[${i}].${field} is required and must be a string`);
      }
    }
    const name = repo['name'] as string;
    if (names.has(name)) {
      throw new Error(`duplicate repo name: "${name}"`);
    }
    names.add(name);
    return {
      name,
      url: repo['url'] as string,
      path: repo['path'] as string,
      ref: repo['ref'] as string,
    };
  });

  return { name: ws['name'] as string, repos };
}
