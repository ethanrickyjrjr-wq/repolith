import { describe, it, expect, afterAll } from 'bun:test';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { appendNote, appendDenyNote, appendOverlapNote, readNotes, type JournalNote } from '../src/coord/journal';

const roots: string[] = [];
async function freshRoot(): Promise<string> {
  const r = await mkdtemp(join(tmpdir(), 'repolith-journal-'));
  roots.push(r);
  return r;
}
afterAll(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

const note = (over: Partial<JournalNote> = {}): JournalNote => ({
  file: 'src/foo.ts',
  kind: 'commit',
  msg: 'changed foo',
  ts: '2026-06-28T12:00:00.000Z',
  ...over,
});

describe('coord journal', () => {
  it('append then read round-trips, oldest-first', async () => {
    const root = await freshRoot();
    await appendNote(root, note({ msg: 'first', ts: '2026-06-28T12:00:00.000Z' }));
    await appendNote(root, note({ msg: 'second', ts: '2026-06-28T12:05:00.000Z' }));
    const got = await readNotes(root, 'src/foo.ts');
    expect(got.map((n) => n.msg)).toEqual(['first', 'second']);
  });

  it('filters by sinceMs (strictly newer)', async () => {
    const root = await freshRoot();
    await appendNote(root, note({ msg: 'old', ts: '2026-06-28T12:00:00.000Z' }));
    await appendNote(root, note({ msg: 'new', ts: '2026-06-28T12:10:00.000Z' }));
    const got = await readNotes(root, 'src/foo.ts', Date.parse('2026-06-28T12:05:00.000Z'));
    expect(got.map((n) => n.msg)).toEqual(['new']);
  });

  it('notes are keyed per-file', async () => {
    const root = await freshRoot();
    await appendNote(root, note({ file: 'src/a.ts', msg: 'a' }));
    await appendNote(root, note({ file: 'src/b.ts', msg: 'b' }));
    expect((await readNotes(root, 'src/a.ts')).map((n) => n.msg)).toEqual(['a']);
    expect((await readNotes(root, 'src/b.ts')).map((n) => n.msg)).toEqual(['b']);
  });

  it('appendDenyNote logs a reviewable collision note naming the holder', async () => {
    const root = await freshRoot();
    const ts = '2026-06-29T16:00:00.000Z';
    await appendDenyNote(root, 'src/foo.ts', 'B', 'A', ts);
    const got = await readNotes(root, 'src/foo.ts');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ file: 'src/foo.ts', kind: 'deny', session_id: 'B', ts });
    expect(got[0].msg).toContain('A'); // names the holder so the log says who-blocked-whom
  });

  it('appendOverlapNote logs a reviewable plan-time catch naming the other session', async () => {
    const root = await freshRoot();
    const ts = '2026-06-29T16:00:00.000Z';
    await appendOverlapNote(root, 'src/foo.ts', 'B', 'A', 'hard', ts);
    const got = await readNotes(root, 'src/foo.ts');
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ file: 'src/foo.ts', kind: 'overlap', session_id: 'B', ts });
    expect(got[0].msg).toContain('A'); // names the other session
    expect(got[0].msg).toContain('hard'); // names the severity that triggered the catch
  });

  it('missing journal → []', async () => {
    const root = await freshRoot();
    expect(await readNotes(root, 'src/nope.ts')).toEqual([]);
  });

  it('skips corrupt lines, keeps valid ones', async () => {
    const root = await freshRoot();
    await appendNote(root, note({ msg: 'good' }));
    // corrupt the file by appending a bad line directly
    const dir = join(root, '.repolith', 'journal');
    await mkdir(dir, { recursive: true });
    const hash = createHash('sha256').update('src/foo.ts').digest('hex').slice(0, 16) + '.jsonl';
    await writeFile(join(dir, hash), JSON.stringify(note({ msg: 'good' })) + '\n{ not json\n', 'utf8');
    const got = await readNotes(root, 'src/foo.ts');
    expect(got.map((n) => n.msg)).toEqual(['good']);
  });
});
