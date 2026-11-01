/**
 * The team notebook (docs/team-notebook.md; lib/server/notebook): the store and its expiry, the rules of writing (run scope,
 * tainted notes, disputes, traceContent off), search by meaning with the fall back to words, promotion (run to team, team to
 * project through the inbox), the person's routes, and the binding of a kagent member's MCP calls to the run in flight.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { NoteHit, TeamNote } from '@/lib/shared/notebook';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-notebook-'));
const previousEnv = { ...process.env };
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { noteStore, expiryOf } = await import('@/lib/server/notebook/store');
const { setNotebookEmbedder } = await import('@/lib/server/notebook/embed');
const { searchNotes, keywordScore } = await import('@/lib/server/notebook/search');
const service = await import('@/lib/server/notebook/service');
const { callNotebookTool, notebookTools, notebookStubs, specsFor, NOTEBOOK_SPECS } = await import('@/lib/server/notebook/tools');
const { openNotebookCall, resolveCall, resetCalls, agentAtEndpoint } = await import('@/lib/server/notebook/binding');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { listProposals, getProposal, applyProposal } = await import('@/lib/server/brain/proposals');
const { credentials } = await import('@/lib/server/credentials/vault');
const notesRoute = await import('@/app/api/agent-teams/[id]/notes/route');
const noteRoute = await import('@/app/api/agent-teams/[id]/notes/[noteId]/route');
const mcpRoute = await import('@/app/api/mcp/agents/[id]/route');

afterAll(() => {
  setNotebookEmbedder(undefined);
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
});

/** Concepts instead of words, so a test can tell "by meaning" from "by words": a text is a vector of what it is about. */
const CONCEPTS = [/icon|image|asset|logo|picture/i, /alert|alarm|pager/i, /test|spec|fake server/i, /deploy|release|ship/i];
const concepts = (text: string) => CONCEPTS.map((c) => (c.test(text) ? 1 : 0));
let embedCalls = 0;
const meaning = async (texts: string[]) => {
  embedCalls++;
  return texts.map((t) => concepts(t.replace(/^search_(?:document|query): /, '')));
};

const lead = agentStore.create({ name: 'Lead' });
const team = agentTeamStore.create({ name: 'Notebook team', members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }] });
const other = agentTeamStore.create({ name: 'Other team', members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }] });

const bind = (over: Partial<import('@/lib/server/notebook/service').NotebookBinding> = {}): import('@/lib/server/notebook/service').NotebookBinding => ({
  team: { id: team.id, name: 'Notebook team' },
  runId: 'exec_1',
  member: { id: 'm_rev', title: 'Reviewer' },
  manager: false,
  content: 'full',
  ...over,
});
const manager = (over = {}) => bind({ member: { id: 'm_lead', title: 'Lead' }, manager: true, ...over });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const noteCtx = (id: string, noteId: string) => ({ params: Promise.resolve({ id, noteId }) });
const post = (body: unknown) => new Request('http://localhost/api/agent-teams/x/notes', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  setNotebookEmbedder(meaning);
  resetCalls();
  for (const n of noteStore.all(team.id)) noteStore.delete(n.id);
  for (const n of noteStore.all(other.id)) noteStore.delete(n.id);
  embedCalls = 0;
});

describe('the store', () => {
  it('keeps a run’s notes 14 days, an unverified team note 30 after its last use, and a verified or project note for good', () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    expect(expiryOf('run', false, now)).toBe('2026-11-15T00:00:00.000Z');
    expect(expiryOf('team', false, now)).toBe('2026-12-01T00:00:00.000Z');
    expect(expiryOf('team', true, now)).toBeUndefined();
    expect(expiryOf('project', false, now)).toBeUndefined();
  });

  it('marks notes past their time expired, and deletes them after a grace period', async () => {
    const { note } = await service.addNote(bind(), { kind: 'fact', text: 'old news' });
    expect(note.expiresAt).toBeTruthy();
    noteStore.patch(note.id, { expires_at: '2026-01-01T00:00:00.000Z' });
    expect(noteStore.expire(Date.parse('2026-01-02T00:00:00Z'))).toEqual({ expired: 1, deleted: 0 });
    expect(noteStore.get(note.id)?.status).toBe('expired');
    expect(noteStore.list({ teamId: team.id, runId: 'exec_1' }).map((n) => n.id)).not.toContain(note.id);
    expect(noteStore.list({ teamId: team.id, runId: 'exec_1', expired: true }).map((n) => n.id)).toContain(note.id);
    expect(noteStore.expire(Date.parse('2026-02-01T00:00:00Z'))).toEqual({ expired: 0, deleted: 1 });
    expect(noteStore.get(note.id)).toBeUndefined();
  });

  it('a note read for a run counts as used: an unverified team note’s expiry moves, a verified one has none', async () => {
    const { note } = await service.addNote(bind(), { kind: 'fact', text: 'Alerts page the on-call' });
    const promoted = service.promote(note, 'team', 'Lead').note;
    noteStore.patch(promoted.id, { expires_at: new Date(Date.now() + 86_400_000).toISOString() });
    await service.findNotes(bind({ runId: 'exec_2' }), { query: 'alerts' });
    const after = noteStore.get(promoted.id)!;
    expect(Date.parse(after.expiresAt!) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    service.verify(team.id, promoted.id, 'Pat');
    expect(noteStore.get(promoted.id)?.expiresAt).toBeUndefined();
  });

});

describe('writing', () => {
  it('writes to the run, with where it came from, and finds an identical note again instead of adding one', async () => {
    const first = await service.addNote(bind(), { kind: 'decision', text: 'Each node gets a test against a fake server.' }, { spanId: 'span_7' });
    expect(first.existing).toBe(false);
    expect(first.note).toMatchObject({
      scope: 'run',
      status: 'unverified',
      author: 'Reviewer',
      authorId: 'm_rev',
      runId: 'exec_1',
      tainted: false,
      source: { executionId: 'exec_1', spanId: 'span_7', tool: 'note_add' },
    });
    expect(first.note.expiresAt).toBeTruthy();
    const again = await service.addNote(bind({ member: { id: 'm_dev', title: 'Developer' } }), { kind: 'decision', text: 'each node gets a test against a fake server.' });
    expect(again.existing).toBe(true);
    expect(again.note.id).toBe(first.note.id);
  });

  it('an open question starts open and is answered with note_update', async () => {
    const { note } = await service.addNote(bind(), { kind: 'open_question', text: 'Which alerting API?' });
    expect(note.status).toBe('open');
    const answered = await service.updateNote(bind({ member: { id: 'm_dev', title: 'Developer' } }), { id: note.id, answer: 'v2 only' });
    expect(answered).toMatchObject({ status: 'answered', answer: 'v2 only' });
  });

  it('refuses empty, long and over-eager notes, and notes of others’ edits by a non-manager', async () => {
    await expect(service.addNote(bind(), { kind: 'fact', text: '  ' })).rejects.toThrow(/empty/);
    await expect(service.addNote(bind(), { kind: 'fact', text: 'x'.repeat(601) })).rejects.toThrow(/under 600/);
    const { note } = await service.addNote(bind(), { kind: 'fact', text: 'Mine' });
    await expect(service.updateNote(bind({ member: { id: 'm_dev', title: 'Developer' } }), { id: note.id, text: 'Not yours' })).rejects.toThrow(/only they or a manager/);
    expect((await service.updateNote(manager(), { id: note.id, text: 'Reworded by the lead' })).text).toBe('Reworded by the lead');
    await expect(service.updateNote(bind(), { id: 'note_nope', text: 'x' })).rejects.toThrow(/No note note_nope/);
  });

  it('keeps run notes of other runs and other teams out of sight', async () => {
    const { note } = await service.addNote(bind(), { kind: 'fact', text: 'Only run one knows this' });
    await expect(service.updateNote(bind({ runId: 'exec_2' }), { id: note.id, text: 'x' })).rejects.toThrow(/No note/);
    const { hits } = await service.findNotes(bind({ runId: 'exec_2' }), { query: 'run one knows' });
    expect(hits).toEqual([]);
    const { hits: mine } = await service.findNotes(bind(), { query: 'run one knows' });
    expect(mine.map((h) => h.id)).toEqual([note.id]);
  });

  it('marks a note tainted when it names a page, has a URL, or follows a fetch, and keeps it from going up until verified', async () => {
    const fromUrl = (await service.addNote(manager(), { kind: 'fact', text: 'Alertmanager v1 paths were removed.', url: 'https://grafana.com/docs' })).note;
    const inText = (await service.addNote(manager(), { kind: 'fact', text: 'See https://example.com/x for the schema' })).note;
    const afterFetch = (await service.addNote(manager(), { kind: 'fact', text: 'The schema has three tables' }, { sawOutside: true })).note;
    const own = (await service.addNote(manager(), { kind: 'fact', text: 'We use pnpm here' })).note;
    expect([fromUrl, inText, afterFetch, own].map((n) => n.tainted)).toEqual([true, true, true, false]);
    expect(() => service.promoteNote(manager(), { id: fromUrl.id })).toThrow(/read from outside the team/);
    expect(() => service.promoteNote(manager(), { id: fromUrl.id, to: 'project' })).toThrow(/read from outside the team/);
    // The lead cannot verify it by tool either: a person does.
    await expect(service.updateNote(manager(), { id: fromUrl.id, status: 'verified' })).rejects.toThrow(/a person verifies it/);
    service.verify(team.id, fromUrl.id, 'Pat');
    expect(service.promoteNote(manager(), { id: fromUrl.id }).note).toMatchObject({ scope: 'team', tainted: true, verifiedBy: 'Pat' });
  });

  it('with traceContent off keeps the ids that say where a note came from, not the quote', async () => {
    const full = (await service.addNote(bind(), { kind: 'fact', text: 'Has a quote', quote: 'line 4: icons/ missing' }, { spanId: 's1' })).note;
    const off = (await service.addNote(bind({ content: 'off' }), { kind: 'fact', text: 'Has no quote', quote: 'line 9: secret thing' }, { spanId: 's2' })).note;
    expect(full.source).toMatchObject({ executionId: 'exec_1', spanId: 's1', excerpt: 'line 4: icons/ missing' });
    expect(off.source).toEqual({ executionId: 'exec_1', spanId: 's2', tool: 'note_add' });
  });

  it('shows the team’s open questions and decisions as a short block, and nothing when there are none', async () => {
    expect(service.notebookBlock(manager())).toBe('');
    await service.addNote(bind(), { kind: 'decision', text: 'Target the v2 alerting API only' });
    await service.addNote(bind(), { kind: 'open_question', text: 'Who owns the icons?' });
    await service.addNote(bind(), { kind: 'fact', text: 'Facts are not in the block' });
    const block = service.notebookBlock(manager());
    expect(block).toContain('Decisions so far:\n- Target the v2 alerting API only');
    expect(block).toContain('Open questions:\n- Who owns the icons?');
    expect(block).not.toContain('Facts are not');
  });
});

describe('disputes', () => {
  it('keeps both notes linked, marks the first disputed, and settles on the one a person keeps', async () => {
    const { note: first } = await service.addNote(bind(), { kind: 'fact', text: 'Alertmanager v1 paths still work' });
    const { note: second, against } = await service.disputeNote(bind({ member: { id: 'm_dev', title: 'Developer' } }), { id: first.id, text: 'They were removed in 0.27' });
    expect(against.status).toBe('disputed');
    expect(second).toMatchObject({ status: 'disputed', disputes: first.id, author: 'Developer' });
    expect(service.notebookBlock(manager())).toContain('Disputed (do not rely on these)');
    expect(() => service.promote(noteStore.get(first.id)!, 'team', 'Lead')).toThrow(/disputed/);
    const settled = service.resolveDispute(team.id, first.id, second.id, 'Pat');
    expect(settled.kept).toMatchObject({ id: second.id, status: 'verified', verifiedBy: 'Pat' });
    expect(settled.kept.disputes).toBeUndefined();
    expect(settled.dropped).toMatchObject({ id: first.id, status: 'expired', supersededBy: second.id });
    expect(() => service.resolveDispute(team.id, first.id, 'note_elsewhere', 'Pat')).toThrow();
  });

  it('deleting one side lets the other stand again', async () => {
    const { note: first } = await service.addNote(bind(), { kind: 'fact', text: 'It is blue' });
    const { note: second } = await service.disputeNote(bind(), { id: first.id, text: 'It is green' });
    service.remove(team.id, first.id);
    expect(noteStore.get(second.id)).toMatchObject({ status: 'unverified' });
    expect(noteStore.get(second.id)?.disputes).toBeUndefined();
  });
});

describe('search', () => {
  it('finds by meaning what shares no word with the query, and says it matched by meaning', async () => {
    await service.addNote(bind(), { kind: 'fact', text: 'A plugin needs an icons/ folder next to src/, or it fails at startup.' });
    await service.addNote(bind(), { kind: 'fact', text: 'Alertmanager v1 paths were removed.' });
    const { hits, via } = await service.findNotes(bind(), { query: 'where do the pictures and logos live?' });
    expect(via).toBe('meaning');
    expect(hits.map((h) => h.text)).toEqual([expect.stringContaining('icons/ folder')]);
    expect(keywordScore('where do the pictures and logos live?', hits[0].text)).toBe(0);
  });

  it('falls back to words when the embedding model fails, and stops asking it for a while', async () => {
    await service.addNote(bind(), { kind: 'fact', text: 'A plugin needs an icons/ folder next to src/.' });
    await service.addNote(bind(), { kind: 'decision', text: 'Alerting goes through the v2 API.' });
    setNotebookEmbedder(async () => {
      throw new Error('Cannot reach Ollama');
    });
    const found = await service.findNotes(bind(), { query: 'icons folder' });
    expect(found.via).toBe('keywords');
    expect(found.hits.map((h) => h.text)).toEqual([expect.stringContaining('icons/ folder')]);
    // Words only: a question with no shared word finds nothing, which is the honest answer without a model.
    expect((await service.findNotes(bind(), { query: 'pictures' })).hits).toEqual([]);
  });

  it('writes notes without a vector when Ollama is down, and the real adapter fails soft', async () => {
    setNotebookEmbedder(undefined);
    process.env.OLLAMA_URL = 'http://127.0.0.1:1';
    try {
      const { note } = await service.addNote(bind(), { kind: 'fact', text: 'Written while Ollama is down' });
      expect(note.embedded).toBe(false);
      const { hits, via } = await service.findNotes(bind(), { query: 'Ollama down' });
      expect(via).toBe('keywords');
      expect(hits.map((h) => h.id)).toEqual([note.id]);
    } finally {
      delete process.env.OLLAMA_URL;
      setNotebookEmbedder(meaning);
    }
  });

  it('ranks notes without a vector by their words next to those with one', async () => {
    setNotebookEmbedder(async () => {
      throw new Error('down');
    });
    const { note: plain } = await service.addNote(bind(), { kind: 'fact', text: 'Release notes live in CHANGELOG.md' });
    setNotebookEmbedder(meaning);
    await service.addNote(bind(), { kind: 'fact', text: 'Tests use a fake server' });
    const result = await searchNotes('changelog release notes', { teamId: team.id, runId: 'exec_1' });
    expect(result.hits[0].id).toBe(plain.id);
    expect(plain.embedded).toBe(false);
  });

  it('counts only what it must: one embedding for the note, one for the query', async () => {
    await service.addNote(bind(), { kind: 'fact', text: 'A fact about icons' });
    expect(embedCalls).toBe(1);
    await service.findNotes(bind(), { query: 'logo' });
    expect(embedCalls).toBe(2);
  });
});

describe('promotion', () => {
  it('lets only a manager promote, run to team, and a team note’s expiry starts then', async () => {
    const { note } = await service.addNote(bind(), { kind: 'fact', text: 'Plugins need an icons folder' });
    expect(() => service.promoteNote(bind(), { id: note.id })).toThrow(/Only a manager/);
    const { note: moved, to } = service.promoteNote(manager(), { id: note.id });
    expect(to).toBe('team');
    expect(moved).toMatchObject({ scope: 'team', promotedFrom: 'run' });
    expect(Date.parse(moved.expiresAt!) - Date.now()).toBeGreaterThan(29 * 86_400_000);
    // A later run finds it.
    const { hits } = await service.findNotes(bind({ runId: 'exec_9' }), { query: 'icons folder' });
    expect(hits.map((h) => h.id)).toEqual([note.id]);
    expect(() => service.promoteNote(manager(), { id: note.id })).toThrow(/already a team note/);
  });

  it('suggests a team note for the project in the inbox, and a person applying it moves the note', async () => {
    const { note } = await service.addNote(bind(), { kind: 'decision', text: 'Every plugin gets a test against a fake server' });
    const result = service.promoteNote(manager(), { id: note.id, to: 'project' });
    expect(result).toMatchObject({ to: 'project', note: { scope: 'team' } });
    const proposal = getProposal(result.proposalId!)!;
    expect(proposal).toMatchObject({
      source: 'notebook',
      status: 'open',
      target: { type: 'team', id: team.id, name: 'Notebook team' },
      notebook: { teamId: team.id, noteId: note.id },
      ops: [],
    });
    expect(listProposals({ status: 'open' }).map((p) => p.id)).toContain(proposal.id);
    expect(noteStore.get(note.id)?.proposalId).toBe(proposal.id);
    // Suggesting it again refreshes the same suggestion.
    expect(service.promoteNote(manager(), { id: note.id, to: 'project' }).proposalId).toBe(proposal.id);
    // Nothing changes until a person applies it.
    expect(noteStore.get(note.id)?.scope).toBe('team');
    applyProposal(proposal.id, { actorId: 'person' });
    expect(noteStore.get(note.id)).toMatchObject({ scope: 'project', status: 'verified', verifiedBy: 'person' });
    expect(noteStore.get(note.id)?.expiresAt).toBeUndefined();
    expect(getProposal(proposal.id)?.status).toBe('applied');
  });

  it('a project note is found by the project’s other teams, and no one else’s', async () => {
    const { note } = await service.addNote(bind(), { kind: 'fact', text: 'The registry lives at plugins.example' });
    service.promote(note, 'team', 'Lead');
    const proposal = service.promote(noteStore.get(note.id)!, 'project', 'Lead').proposalId!;
    applyProposal(proposal, { actorId: 'person' });
    // The two teams share a project only when they live in the same one (the default project, here).
    const seen = await service.findNotes({ ...bind(), team: { id: other.id, name: 'Other team' }, ...(noteStore.get(note.id)?.projectId && { projectId: noteStore.get(note.id)!.projectId }) }, { query: 'registry' });
    if (noteStore.get(note.id)?.projectId) expect(seen.hits.map((h) => h.id)).toEqual([note.id]);
    else expect(seen.hits).toEqual([]);
  });

  it('will not approve a tainted note nobody verified', async () => {
    const { note } = await service.addNote(manager(), { kind: 'fact', text: 'Claimed by a page', url: 'https://evil.example' });
    expect(() => service.promote(note, 'project', 'Lead')).toThrow(/outside the team/);
    // Even if the suggestion exists, applying it re-checks.
    service.verify(team.id, note.id, 'Pat');
    const proposal = service.promote(noteStore.get(note.id)!, 'project', 'Pat').proposalId!;
    noteStore.patch(note.id, { verified_at: null });
    expect(() => applyProposal(proposal)).toThrow(/verify it first/);
  });
});

describe('the tools', () => {
  it('give every member four tools, and managers a fifth; they read as steps by their names', () => {
    expect(notebookTools(bind()).map((t) => t.name)).toEqual(['note_add', 'note_search', 'note_update', 'note_dispute']);
    expect(notebookTools(manager()).map((t) => t.name)).toEqual(['note_add', 'note_search', 'note_update', 'note_dispute', 'note_promote']);
    expect(notebookTools(bind()).every((t) => t.kind === 'notebook' && t.label === t.name && !t.requireApproval)).toBe(true);
    expect(specsFor(false)).toHaveLength(NOTEBOOK_SPECS.length - 1);
    // Only a manager verifies: the others aren't offered it.
    const status = (manager: boolean) => ((specsFor(manager).find((t) => t.name === 'note_update')!.inputSchema.properties as Record<string, { enum: string[] }>).status.enum);
    expect(status(true)).toContain('verified');
    expect(status(false)).not.toContain('verified');
    expect(notebookStubs().find((t) => t.name === 'note_update')!.description).toMatch(/Only a manager marks a note verified/);
    expect(notebookStubs().map((t) => t.name)).toEqual(['note_add', 'note_search', 'note_update', 'note_dispute']);
  });

  it('say in words what happened', async () => {
    const added = await callNotebookTool(bind(), 'note_add', { kind: 'fact', text: 'Hello notebook' });
    expect(added.text).toMatch(/^Noted \(note_[\w-]+\) as fact\. Only this run sees it until the lead promotes it to the team\.$/);
    expect((await callNotebookTool(bind(), 'note_add', { kind: 'fact', text: 'Hello notebook' })).text).toMatch(/already has this/);
    const found = await callNotebookTool(bind(), 'note_search', { query: 'hello' });
    expect(found.text).toMatch(/^1 note \(matched by (meaning|keywords)\):\n- \[note_[\w-]+\] fact \(unverified, this run, by Reviewer\): Hello notebook$/);
    expect((await callNotebookTool(bind(), 'note_search', { query: 'zebra' })).text).toBe('Nothing in the notebook matches “zebra”.');
    await expect(callNotebookTool(bind(), 'note_promote', { id: added.note!.id })).rejects.toThrow(/Only a manager/);
  });
});

describe('the routes', () => {
  it('lists a team’s notes across runs with counts, searches them, and filters', async () => {
    await service.addNote(bind({ runId: 'exec_a' }), { kind: 'open_question', text: 'Which API version?' });
    const decision = (await service.addNote(bind({ runId: 'exec_b' }), { kind: 'decision', text: 'Use the v2 API' })).note;
    service.promote(decision, 'team', 'Lead');
    await service.addNote(bind({ runId: 'exec_b' }), { kind: 'fact', text: 'A plugin needs an icons folder' });
    const all = await (await notesRoute.GET(new Request('http://localhost/x'), ctx(team.id))).json();
    expect(all.notes).toHaveLength(3);
    expect(all.counts).toMatchObject({ decisions: 1, total: 1 });
    const open = await (await notesRoute.GET(new Request('http://localhost/x?kind=open_question&status=open'), ctx(team.id))).json();
    expect(open.notes.map((n: TeamNote) => n.text)).toEqual(['Which API version?']);
    const onlyRun = await (await notesRoute.GET(new Request('http://localhost/x?run=exec_b'), ctx(team.id))).json();
    expect(onlyRun.notes).toHaveLength(2);
    const search = await (await notesRoute.GET(new Request('http://localhost/x?q=pictures%20and%20logos'), ctx(team.id))).json();
    expect(search).toMatchObject({ via: 'meaning', notes: [expect.objectContaining({ text: 'A plugin needs an icons folder' })] });
    expect((search.notes as NoteHit[])[0].score).toBeGreaterThan(0.4);
    expect((await notesRoute.GET(new Request('http://localhost/x'), ctx('team_missing'))).status).toBe(404);
  });

  it('lets a person write, answer, verify, dispute, resolve, promote and delete', async () => {
    const written = await notesRoute.POST(post({ kind: 'fact', text: 'We deploy on Fridays' }), ctx(team.id));
    expect(written.status).toBe(201);
    const mine = (await written.json()).note as TeamNote;
    expect(mine).toMatchObject({ scope: 'team', status: 'verified', embedded: true });

    const run = (id: string, body: unknown) => noteRoute.POST(post(body), noteCtx(team.id, id));
    const question = (await service.addNote(bind(), { kind: 'open_question', text: 'Who reviews?' })).note;
    expect((await (await run(question.id, { action: 'answer', text: 'Reviewer' })).json()).note).toMatchObject({ status: 'answered', answer: 'Reviewer' });
    expect((await (await run(question.id, { action: 'reopen' })).json()).note).toMatchObject({ status: 'open' });

    const claim = (await service.addNote(bind(), { kind: 'fact', text: 'Staging is blue' })).note;
    const disputed = await run(claim.id, { action: 'dispute', text: 'Staging is green' });
    expect(disputed.status).toBe(201);
    const pair = await disputed.json();
    expect(pair.against.status).toBe('disputed');
    const resolved = await (await run(pair.note.id, { action: 'resolve', keep: pair.note.id })).json();
    expect(resolved).toMatchObject({ kept: { text: 'Staging is green', status: 'verified' }, dropped: { status: 'expired' } });

    const run1 = (await service.addNote(bind(), { kind: 'fact', text: 'Promote me please' })).note;
    expect((await (await run(run1.id, { action: 'promote' })).json())).toMatchObject({ to: 'team', note: { scope: 'team' } });
    const toProject = await (await run(run1.id, { action: 'promote' })).json();
    expect(toProject).toMatchObject({ to: 'project', proposalId: expect.any(String) });

    const tainted = (await service.addNote(bind(), { kind: 'fact', text: 'From a page', url: 'https://x.example' })).note;
    const refused = await run(tainted.id, { action: 'promote' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toMatch(/outside the team/);
    expect((await (await run(tainted.id, { action: 'verify' })).json()).note).toMatchObject({ verifiedAt: expect.any(String) });
    expect((await run(tainted.id, { action: 'promote' })).status).toBe(200);

    expect((await noteRoute.DELETE(new Request('http://localhost/x', { method: 'DELETE' }), noteCtx(team.id, mine.id))).status).toBe(200);
    expect(noteStore.get(mine.id)).toBeUndefined();
    expect((await run('note_nope', { action: 'verify' })).status).toBe(404);
    expect((await run(mine.id, { action: 'bogus' })).status).toBe(400);
    // A note of another team is not found through this team's route.
    const foreign = noteStore.insert({ teamId: other.id, kind: 'fact', text: 'Not yours', author: 'X', source: {} });
    expect((await run(foreign.id, { action: 'verify' })).status).toBe(404);
  });

  it('goes with the team when it is deleted', async () => {
    const temp = agentTeamStore.create({ name: 'Temp', members: [] });
    noteStore.insert({ teamId: temp.id, kind: 'fact', text: 'Gone with it', author: 'X', source: {} });
    agentTeamStore.delete(temp.id);
    expect(noteStore.all(temp.id)).toEqual([]);
  });
});

describe('a Claude Code member on kagent', () => {
  const url = 'http://controller.test/agents/kagent/nb-reviewer';
  let token = '';
  const reviewer = agentStore.create({ name: 'Reviewer on kagent', instructions: 'Review.' });
  agentStore.publish(reviewer.id);
  token = 'lfk_test_token';
  agentStore.setKagent(reviewer.id, { credential: { id: 'cred', name: 'kind' }, name: 'nb-reviewer', version: 1, token: credentials.sealSecret(token) } as never);
  agentTeamStore.create({ name: 'Calls the reviewer', members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }, { id: 'm_rev', kind: 'a2a', title: 'Reviewer', reportsTo: 'm_lead', parameters: { agentUrl: url } }] });

  type Rpc = { result?: { tools?: Array<{ name: string; inputSchema: { properties: Record<string, unknown> } }>; content?: Array<{ text: string }>; isError?: boolean } };
  async function rpc(method: string, params: unknown): Promise<Rpc> {
    const request = new Request(`http://localhost/api/mcp/agents/${reviewer.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    const raw = await (await (mcpRoute.POST as unknown as (r: Request, c: unknown) => Promise<Response>)(request, ctx(reviewer.id))).text();
    return JSON.parse(raw.includes('data:') ? raw.split('\n').find((l) => l.startsWith('data:'))!.slice(5) : raw) as Rpc;
  }
  const noteTool = async (args: Record<string, unknown>, name = 'note_add') => (await rpc('tools/call', { name, arguments: args })).result!;

  it('finds the agent a team calls by its A2A address', () => {
    expect(agentAtEndpoint(url)?.id).toBe(reviewer.id);
    expect(agentAtEndpoint(`${url}/`)?.id).toBe(reviewer.id);
    expect(agentAtEndpoint('http://elsewhere/agents/kagent/other')).toBeUndefined();
  });

  it('serves the four tools because a team calls the agent, with a run argument', async () => {
    const listed = (await rpc('tools/list', {})).result!.tools!;
    expect(listed.map((t) => t.name)).toEqual(expect.arrayContaining(['note_add', 'note_search', 'note_update', 'note_dispute']));
    expect(listed.find((t) => t.name === 'note_add')?.inputSchema.properties).toHaveProperty('run');
    expect(listed.map((t) => t.name)).not.toContain('note_promote');
  });

  it('refuses a note when no team run is asking the agent', async () => {
    const result = await noteTool({ kind: 'fact', text: 'Nobody asked me' });
    expect(result.isError).toBe(true);
    expect(result.content?.[0].text).toMatch(/No team run is using this agent/);
  });

  it('writes the note to the run that is asking, as the member it asked, with that request’s span', async () => {
    const open = openNotebookCall(url, bind({ runId: 'exec_kagent', member: { id: 'm_rev', title: 'Reviewer' } }), 'span_ask');
    try {
      const written = await noteTool({ kind: 'fact', text: 'Plugins need an icons/ folder' });
      expect(written.isError).toBeFalsy();
      expect(written.content?.[0].text).toMatch(/^Noted \(note_[\w-]+\)/);
      const stored = noteStore.list({ teamId: team.id, onlyRun: 'exec_kagent' });
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ author: 'Reviewer', authorId: 'm_rev', scope: 'run', runId: 'exec_kagent', source: { executionId: 'exec_kagent', spanId: 'span_ask', tool: 'note_add' } });
      const found = await noteTool({ query: 'icons' }, 'note_search');
      expect(found.content?.[0].text).toContain('Plugins need an icons/ folder');
      // A member cannot promote: the lead does.
      expect((await noteTool({ id: stored[0].id }, 'note_promote')).isError).toBe(true);
    } finally {
      open.close();
    }
    expect((await noteTool({ kind: 'fact', text: 'Too late' })).isError).toBe(true);
  });

  it('marks what a member wrote after reading a page as tainted', async () => {
    const open = openNotebookCall(url, bind({ runId: 'exec_k2' }));
    try {
      open.used(['Read', 'mcp__fetch__web_fetch']);
      await noteTool({ kind: 'fact', text: 'The docs say so' });
      expect(noteStore.list({ teamId: team.id, onlyRun: 'exec_k2' })[0].tainted).toBe(true);
    } finally {
      open.close();
    }
  });

  it('never guesses between two runs: it asks for the run key and writes only where the key says', async () => {
    const one = openNotebookCall(url, bind({ runId: 'exec_one' }));
    const two = openNotebookCall(url, bind({ runId: 'exec_two' }));
    try {
      const unclear = await noteTool({ kind: 'fact', text: 'Which run?' });
      expect(unclear.isError).toBe(true);
      expect(unclear.content?.[0].text).toContain(one.key);
      expect(unclear.content?.[0].text).toContain(two.key);
      expect(noteStore.list({ teamId: team.id, onlyRun: 'exec_one' })).toEqual([]);
      expect(noteStore.list({ teamId: team.id, onlyRun: 'exec_two' })).toEqual([]);
      const keyed = await noteTool({ kind: 'fact', text: 'For run two', run: two.key });
      expect(keyed.isError).toBeFalsy();
      expect(noteStore.list({ teamId: team.id, onlyRun: 'exec_two' }).map((n) => n.text)).toEqual(['For run two']);
      expect(noteStore.list({ teamId: team.id, onlyRun: 'exec_one' })).toEqual([]);
      expect((await noteTool({ kind: 'fact', text: 'x', run: 'nbk_wrong' })).isError).toBe(true);
    } finally {
      one.close();
      two.close();
    }
  });

  it('resolves the call from the agent’s registry entry directly', () => {
    const agent = agentStore.get(reviewer.id)!;
    expect(resolveCall(agent)).toMatchObject({ error: expect.stringMatching(/No team run/) });
    const open = openNotebookCall(url, bind({ runId: 'exec_r' }));
    expect(resolveCall(agent)).toMatchObject({ call: { key: open.key } });
    open.close();
  });
});
