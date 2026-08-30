import { parse } from 'smol-toml';
import type { WorkspaceManifest, RepoEntry, CoordConfig } from './types.js';

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

  let coord: CoordConfig | undefined;
  const rawCoord = raw['coord'] as Record<string, unknown> | undefined;
  if (rawCoord) {
    const out: CoordConfig = {};
    const appendOnly = rawCoord['append_only'];
    if (appendOnly !== undefined) {
      if (!Array.isArray(appendOnly) || appendOnly.some((v) => typeof v !== 'string')) {
        throw new Error('coord.append_only must be an array of strings');
      }
      out.append_only = appendOnly as string[];
    }
    const specPatterns = rawCoord['spec_patterns'];
    if (specPatterns !== undefined) {
      if (!Array.isArray(specPatterns) || specPatterns.some((v) => typeof v !== 'string')) {
        throw new Error('coord.spec_patterns must be an array of strings');
      }
      out.spec_patterns = specPatterns as string[];
    }
    if (Object.keys(out).length) coord = out;
  }

  return { name: ws['name'] as string, repos, coord };
}
