import { describe, it, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPlanText } from '../src/commands/plan';

describe('readPlanText()', () => {
  it('prefers inline tool_input.plan (the normal injected path)', async () => {
    const plan = '## Refactor auth\nEdit `src/auth.ts`.';
    expect(await readPlanText({ plan, planFilePath: '/does/not/matter.md' }, '/ws')).toBe(plan);
  });

  it('falls back to reading planFilePath when plan is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repolith-plan-'));
    try {
      const file = join(root, 'plan.md');
      const body = '## From disk\nEdit `src/from-disk.ts`.';
      await writeFile(file, body, 'utf8');
      expect(await readPlanText({ plan: '', planFilePath: file }, root)).toBe(body);
      expect(await readPlanText({ planFilePath: file }, root)).toBe(body); // plan absent entirely
      expect(await readPlanText({ plan: '   ', planFilePath: file }, root)).toBe(body); // whitespace-only
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts a workspace-relative planFilePath', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repolith-plan-'));
    try {
      await mkdir(join(root, 'docs'), { recursive: true });
      const body = '## Nested\nEdit `src/x.ts`.';
      await writeFile(join(root, 'docs', 'plan.md'), body, 'utf8');
      expect(await readPlanText({ plan: '', planFilePath: 'docs/plan.md' }, root)).toBe(body);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // Security regression: planFilePath arrives on untrusted hook stdin, and whatever this
  // returns is broadcast into every peer session's context as summary/plan_excerpt. A path
  // outside the workspace must never be read, however it's spelled.
  it('refuses a planFilePath that escapes the workspace', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'repolith-plan-'));
    try {
      const root = join(parent, 'ws');
      await mkdir(root, { recursive: true });
      const secret = join(parent, 'secret.md');
      await writeFile(secret, 'API_KEY=super-secret-value', 'utf8');

      // absolute path outside the root
      expect(await readPlanText({ plan: '', planFilePath: secret }, root)).toBe('');
      // relative traversal out of the root
      expect(await readPlanText({ plan: '', planFilePath: '../secret.md' }, root)).toBe('');
      // inline plan still wins and is untouched by the containment check
      expect(await readPlanText({ plan: 'inline wins', planFilePath: secret }, root)).toBe('inline wins');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it('returns "" without throwing when planFilePath is unreadable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'repolith-plan-'));
    try {
      expect(await readPlanText({ plan: '', planFilePath: join(root, 'no-such-plan.md') }, root)).toBe('');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns "" for an empty / missing tool_input', async () => {
    expect(await readPlanText(undefined, '/ws')).toBe('');
    expect(await readPlanText({}, '/ws')).toBe('');
  });
});
