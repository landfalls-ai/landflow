/**
 * C02 for the team notebook: a note past its expiry is gone at once (the lazy-expiry bug), a note can be forgotten softly with a
 * reason and restored, the sweeper keeps forgotten notes, and settling a dispute is one transaction.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-notebook-lifecycle-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { noteStore } = await import('@/lib/server/notebook/store');
const { forgetNote, restoreNote, supersedeNote } = await import('@/lib/server/notebook/lifecycle');
const service = await import('@/lib/server/notebook/service');
const { database } = await import('@/lib/server/db');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const notesRoute = await import('@/app/api/agent-teams/[id]/notes/route');
const noteRoute = await import('@/app/api/agent-teams/[id]/notes/[noteId]/route');

const team = agentTeamStore.create({ name: 'Lifecycle team', members: [] });
const ctx = (id: string, noteId?: string) => ({ params: Promise.resolve(noteId ? { id, noteId } : { id }) }) as never;
const add = (text: string, over: Partial<Parameters<typeof noteStore.insert>[0]> = {}) => noteStore.insert({ teamId: team.id, kind: 'fact', text, scope: 'team', author: 'Tester', source: {}, ...over });
const texts = (notes: Array<{ text: string }>) => notes.map((n) => n.text).sort();

afterAll(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

beforeEach(() => {
  for (const n of noteStore.all(team.id)) noteStore.delete(n.id);
});

describe('T-8 lazy expiry', () => {
  it('a note past its expires_at is out of the list with no sweep, and back with expired', () => {
    const a = add('stays');
    const b = add('lapsed');
    database().upsert('team_notes', { ...database().get<Record<string, string>>('SELECT * FROM team_notes WHERE id = ?', b.id)!, expires_at: new Date(Date.now() - 1_000).toISOString() });
    expect(b.status).toBe('unverified');
    expect(texts(noteStore.list({ teamId: team.id, allRuns: true }))).toEqual(['stays']);
    expect(texts(noteStore.list({ teamId: team.id, allRuns: true, expired: true }))).toEqual(['lapsed', 'stays']);
    expect(noteStore.counts(team.id).total).toBe(1);
    void a;
  });
});

describe('T-8 forget', () => {
  it('hides a forgotten note, lists it with forgotten=only, audits it, and restore brings it back', () => {
    const note = add('wrong claim');
    const forgotten = forgetNote(team.id, note.id, { reason: 'It was a rumour' }, 'Tester');
    expect(forgotten).toMatchObject({ forgetReason: 'It was a rumour', forgottenBy: 'Tester' });
    expect(forgotten.forgottenAt).toBeDefined();
    expect(noteStore.list({ teamId: team.id, allRuns: true })).toEqual([]);
    expect(texts(noteStore.list({ teamId: team.id, allRuns: true, forgotten: 'only' }))).toEqual(['wrong claim']);
    restoreNote(team.id, note.id, 'Tester');
    expect(texts(noteStore.list({ teamId: team.id, allRuns: true }))).toEqual(['wrong claim']);
    const events = database().all<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'notebook.note_%' ORDER BY at, id");
    expect(events.map((e) => e.action)).toEqual(['notebook.note_forgotten', 'notebook.note_restored']);
  });

  it('needs a reason; forget-after sets the expiry', () => {
    const note = add('short lived');
    expect(() => forgetNote(team.id, note.id, { reason: ' ' }, 'T')).toThrow(/reason/);
    const soon = new Date(Date.now() + 3_600_000).toISOString();
    expect(forgetNote(team.id, note.id, { reason: 'temporary', forgetAfter: soon }, 'T').expiresAt).toBe(soon);
    expect(() => forgetNote(team.id, note.id, { reason: 'x', forgetAfter: new Date(Date.now() + 5).toISOString() }, 'T')).toThrow(/forgetAfter/);
  });

  it('the sweeper deletes an expired note past the grace and keeps a forgotten one', () => {
    const lapsed = add('lapsed long ago');
    const kept = add('forgotten and old');
    forgetNote(team.id, kept.id, { reason: 'wrong' }, 'T');
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    for (const id of [lapsed.id, kept.id]) database().upsert('team_notes', { ...database().get<Record<string, string>>('SELECT * FROM team_notes WHERE id = ?', id)!, expires_at: old });
    const swept = noteStore.expire();
    expect(swept.deleted).toBe(1);
    expect(noteStore.get(lapsed.id)).toBeUndefined();
    expect(noteStore.get(kept.id)?.forgottenAt).toBeDefined();
    expect(noteStore.get(kept.id)?.status).not.toBe('expired');
  });
});

describe('T-8 settling a dispute', () => {
  it('patchMany writes every note or none', () => {
    const a = add('a');
    const b = add('b');
    expect(() => noteStore.patchMany([{ id: a.id, columns: { status: 'verified' } }, { id: b.id, columns: { 'bad-column': 1 } }])).toThrow();
    expect(noteStore.get(a.id)?.status).toBe('unverified');
  });

  it('supersedeNote marks the loser replaced and verifies the winner together', () => {
    const keep = add('keep me');
    const drop = add('drop me');
    const { kept, dropped } = supersedeNote(keep, drop, 'Tester');
    expect(dropped).toMatchObject({ status: 'expired', supersededBy: keep.id });
    expect(kept.status).toBe('verified');
    expect(kept.expiresAt).toBeUndefined();
  });

  it('T-11: a dispute whose second write fails leaves both notes as they were', async () => {
    const claim = add('the claim');
    const { note } = await service.personDispute(team.id, claim.id, 'Tester', 'the truth');
    const db = database();
    const real = db.upsert.bind(db);
    let writes = 0;
    const spy = vi.spyOn(db, 'upsert').mockImplementation((table, row) => {
      if (table === 'team_notes' && ++writes === 2) throw new Error('disk full');
      return real(table, row);
    });
    expect(() => service.resolveDispute(team.id, claim.id, note.id, 'Tester')).toThrow(/disk full/);
    spy.mockRestore();
    expect(noteStore.get(claim.id)).toMatchObject({ status: 'disputed' });
    expect(noteStore.get(claim.id)?.supersededBy).toBeUndefined();
    expect(noteStore.get(note.id)).toMatchObject({ status: 'disputed' });
    const settled = service.resolveDispute(team.id, claim.id, note.id, 'Tester');
    expect(settled.dropped).toMatchObject({ id: claim.id, status: 'expired', supersededBy: note.id });
  });
});

describe('T-9 routes', () => {
  const post = async (noteId: string, body: unknown) => noteRoute.POST(new Request('http://localhost/x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ctx(team.id, noteId));

  it('POST forget and restore, and GET ?forgotten=1', async () => {
    const note = add('to forget');
    add('stays');
    expect((await post(note.id, { action: 'forget', reason: '' })).status).toBe(400);
    const forgot = await post(note.id, { action: 'forget', reason: 'Not true' });
    expect(forgot.status).toBe(200);
    expect(((await forgot.json()) as { note: { forgetReason: string } }).note.forgetReason).toBe('Not true');
    const list = (await (await notesRoute.GET(new Request('http://localhost/x'), ctx(team.id))).json()) as { notes: Array<{ text: string }>; counts: { total: number } };
    expect(texts(list.notes)).toEqual(['stays']);
    expect(list.counts.total).toBe(1);
    const only = (await (await notesRoute.GET(new Request('http://localhost/x?forgotten=1'), ctx(team.id))).json()) as { notes: Array<{ text: string; forgetReason: string }> };
    expect(only.notes).toMatchObject([{ text: 'to forget', forgetReason: 'Not true' }]);
    expect((await post(note.id, { action: 'restore' })).status).toBe(200);
    expect(texts(((await (await notesRoute.GET(new Request('http://localhost/x'), ctx(team.id))).json()) as { notes: Array<{ text: string }> }).notes)).toEqual(['stays', 'to forget']);
    expect((await post('note_missing', { action: 'forget', reason: 'x' })).status).toBe(404);
  });
});
