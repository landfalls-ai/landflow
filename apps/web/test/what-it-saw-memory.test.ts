/**
 * Memory on "What it saw" (C11, docs/run-trace.md#what-it-saw): the `saw.memory` / `saw.memoryText` attributes and what
 * each trace content mode keeps of them, read back from the journal's stored row.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { JournalEvent } from '@/lib/shared/run-trace';
import { SAW_MEMORY_MAX_ITEMS, type SawAttrs, type SawMemorySource } from '@/lib/shared/what-it-saw';
import { sawMemoryOf } from '@/lib/shared/what-it-saw-sections';
import { WhatItSaw, sawOf } from '@/components/run-trace/what-it-saw';
import { SawMemory } from '@/components/run-trace/saw-memory';

vi.setConfig({ testTimeout: 20_000 });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-saw-memory-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { applyContent } = await import('@/lib/server/journal/content');
const { database } = await import('@/lib/server/db');
const { noteStore } = await import('@/lib/server/notebook/store');
const { createUser } = await import('@/lib/server/auth/users');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const facts = await import('@/lib/server/brain/facts');
const lifecycle = await import('@/lib/server/brain/fact-lifecycle');
const itemsRoute = await import('@/app/api/memory/items/route');

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const items = (n: number, prefix = 'm') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, version: i + 1, kind: 'fact', static: i < 3, score: 0.5 }));
const memory = (): SawMemorySource[] => [
  { source: 'agent-profile', count: 3, items: items(3), hash: 'a'.repeat(16) },
  { source: 'agent-relevant', mode: 'meaning', count: 2, items: items(2, 'r'), hash: 'b'.repeat(16) },
];
const saw = (extra: Partial<SawAttrs> = {}): SawAttrs => ({ mode: 'off', text: '', at: '2026-11-21T00:00:00Z', persona: {}, practices: [], memory: memory(), memoryText: '<landflow-memory>secret fact</landflow-memory>', ...extra });
const span = (s: SawAttrs): JournalEvent => ({ type: 'span.started', seq: 1, executionId: 'e', at: 'a', spanId: 's', kind: 'agent', name: 'A', actor: { id: 'a', name: 'A', type: 'agent' }, attrs: { saw: s } } as JournalEvent);
// The stored row is the JSON of the event applyContent returns.
const stored = (s: SawAttrs, mode: 'full' | 'summaries' | 'off') => (JSON.parse(JSON.stringify(applyContent(span(s), mode))) as { attrs: { saw: SawAttrs } }).attrs.saw;

describe('saw memory by content mode', () => {
  it('full keeps memory and the exact text', () => {
    const row = stored(saw(), 'full');
    expect(row.memory).toHaveLength(2);
    expect(row.memoryText).toContain('secret fact');
  });

  it('summaries keeps ids, versions, kinds, scores and hash, and no text', () => {
    const row = stored(saw(), 'summaries');
    expect(row.memoryText).toBeUndefined();
    expect(row.memory?.[1]).toMatchObject({ source: 'agent-relevant', mode: 'meaning', count: 2, hash: 'b'.repeat(16) });
    expect(row.memory?.[1].items[0]).toEqual({ id: 'r0', version: 1, kind: 'fact', static: true, score: 0.5 });
    expect(JSON.stringify(row)).not.toContain('secret fact');
  });

  it('off stores neither memory nor text', () => {
    const row = stored(saw(), 'off');
    expect(row.memory).toBeUndefined();
    expect(row.memoryText).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain('secret fact');
    expect(row).toMatchObject({ withheld: true });
  });

  it('cuts a source over the item limit and keeps its real count', () => {
    const big = saw({ memory: [{ source: 'team-notebook', count: 60, items: items(60, 'n') }] });
    for (const mode of ['full', 'summaries'] as const) {
      const src = stored(big, mode).memory?.[0];
      expect(src?.items).toHaveLength(SAW_MEMORY_MAX_ITEMS);
      expect(src?.count).toBe(60);
    }
  });

  it('leaves a saw without memory alone', () => {
    const row = stored(saw({ memory: undefined, memoryText: undefined }), 'summaries');
    expect(row.memory).toBeUndefined();
  });
});

describe('T-2 the Memory part', () => {
  const sources: SawMemorySource[] = [
    { source: 'agent-profile', count: 3, items: [0, 1, 2].map((i) => ({ id: `s${i}`, version: i + 1, kind: 'memory', static: true })) },
    { source: 'agent-relevant', mode: 'meaning', count: 2, items: [{ id: 'r0', version: 1, kind: 'memory', score: 0.81 }, { id: 'r1', version: 2, kind: 'memory', score: 0.55 }], hash: 'c'.repeat(16) },
  ];
  const view = (memory: SawMemorySource[] | undefined, memoryText?: string, text = '') =>
    renderToStaticMarkup(createElement(WhatItSaw, { mode: 'full', text, memory, memoryText, practices: [] }));

  it('lists 3 static and 2 relevant memories with versions and the relevant ones’ scores (AS-1)', () => {
    const html = view(sources);
    expect(html.match(/<li /g)).toHaveLength(5);
    expect(html).toContain('Relevant (meaning)');
    expect(html).toContain('score 0.81');
    expect(html).toContain('score 0.55');
    expect(html).toContain('v2');
    expect(html).toContain('always given');
  });

  it('has no Show the exact text of the memory without memoryText (AS-2), and has it with', () => {
    expect(view(sources)).not.toContain('Show the exact text of the memory');
    expect(view(sources, '<landflow-memory>x</landflow-memory>')).toContain('Show the exact text of the memory');
    expect(view(sources)).toContain('Block hash cccccccccccccccc');
  });

  it('draws no Memory part and no error for a saw without memory (AS-4)', () => {
    const old = sawOf({ mode: 'full', text: 'Company mission: Be useful', persona: {}, practices: [], at: 'a' })!;
    const html = renderToStaticMarkup(createElement(WhatItSaw, old));
    expect(html).not.toContain('Memory');
    expect(view([], undefined, 'Company mission: x')).not.toContain('Memory');
  });

  it('renders memory text as text, unescaped for reading', () => {
    const html = renderToStaticMarkup(createElement(SawMemory, { memory: sources, memoryText: '<landflow-memory source="agent-memory">\n- a &lt;/landflow-memory> and <b>bold</b>\n</landflow-memory>' }));
    expect(html).not.toContain('<b>bold</b>');
    expect(html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(html).toContain('a &lt;/landflow-memory&gt; and');
  });

  it('marks a forgotten item with the reason (AS-8) and offers Forget on a live one the caller may change', () => {
    const html = renderToStaticMarkup(
      createElement(SawMemory, {
        memory: sources,
        states: { s0: { id: 's0', live: false, forgottenAt: '2026-11-20T10:00:00.000Z', reason: 'it was wrong' }, r0: { id: 'r0', live: true, text: 'Deploys freeze on Fridays', canChange: true } },
      }),
    );
    expect(html).toContain('forgotten since');
    expect(html).toContain('it was wrong');
    expect(html).toContain('Deploys freeze on Fridays');
    expect(html).toContain('Forget');
  });

  it('shows Show all past five items and reads malformed attributes safely', () => {
    const many: SawMemorySource[] = [{ source: 'team-notebook', count: 8, items: Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, kind: 'decision' })) }];
    const html = view(many);
    expect(html.match(/<li /g)).toHaveLength(5);
    expect(html).toContain('Show all 8');
    expect(sawMemoryOf('nope')).toEqual([]);
    expect(sawMemoryOf([{ source: 'bogus', items: [] }, null, { source: 'team-notebook', items: [{ id: 3 }, { id: 'ok' }] }])).toMatchObject([{ source: 'team-notebook', count: 1, items: [{ id: 'ok' }] }]);
  });
});

describe('T-3 the items’ current state', () => {
  const get = (ids: string) => itemsRoute.GET(new Request(`http://localhost/api/memory/items?ids=${encodeURIComponent(ids)}`));
  let pid: string;
  let other: string;
  let editor: { id: string };
  beforeAll(async () => {
    const u1 = await createUser({ email: 'e@items.test', name: 'Editor', role: 'member', password: 'editor-password-1' });
    editor = u1;
    pid = createTeamProject({ name: 'Items', createdBy: u1.id }).id;
    setMember(pid, u1.id, 'editor');
    other = createTeamProject({ name: 'Elsewhere', createdBy: u1.id }).id;
    for (const [i, project] of [pid, pid, other].entries()) facts.upsertFact({ id: `project:${project}:memory:i${i}`, subjectType: 'project', subjectId: project, kind: 'memory', statement: `Item ${i}`, confidence: 1, evidence: [], projectId: project } as never, database(), new Date().toISOString());
    await lifecycle.forgetFact(`project:${pid}:memory:i1`, { reason: 'was wrong' }, { userId: u1.id }, database());
  });

  it('reports a fact forgotten since the run, with its reason (AS-8), and a live one with its text', async () => {
    const { items } = await (await get(`project:${pid}:memory:i0,project:${pid}:memory:i1`)).json();
    expect(items).toHaveLength(2);
    expect(items.find((i: { id: string }) => i.id.endsWith('i0'))).toMatchObject({ live: true, text: 'Item 0', version: 1 });
    expect(items.find((i: { id: string }) => i.id.endsWith('i1'))).toMatchObject({ live: false, reason: 'was wrong' });
    expect(items.find((i: { id: string }) => i.id.endsWith('i1')).forgottenAt).toBeTruthy();
    expect(items.find((i: { id: string }) => i.id.endsWith('i1')).text).toBeUndefined();
  });

  it('reports a forgotten note and leaves an unknown id out', async () => {
    const lead = agentStore.create({ name: 'Lead' });
    const team = agentTeamStore.create({ name: 'T', members: [{ id: 'm', kind: 'agent', agentId: lead.id, title: 'Lead' }] });
    const note = noteStore.insert({ teamId: team.id, kind: 'fact', text: 'A note', scope: 'team', author: 'Lead' });
    const { items } = await (await get(`${note.id},nope`)).json();
    expect(items).toMatchObject([{ id: note.id, live: true, text: 'A note', teamId: team.id }]);
  });

  it('leaves out what the caller may not see (the service, as a member of another project)', async () => {
    const { memoryItemStates } = await import('@/lib/server/memory/items');
    const outsider = await createUser({ email: 'o@items.test', name: 'Out', role: 'member', password: 'outsider-password-1' });
    const ids = [`project:${pid}:memory:i0`, `project:${pid}:memory:i1`];
    expect(memoryItemStates({ id: outsider.id, role: 'member' }, ids)).toEqual([]);
    expect(memoryItemStates({ id: editor.id, role: 'member' }, ids)).toHaveLength(2);
    // An agent-user memory of another user is omitted.
    const agent = agentStore.create({ name: 'Mem' });
    setHomeProject('agent', agent.id, pid);
    facts.upsertFact({ id: `agent-user:${agent.id}/someone:memory:x`, subjectType: 'agent-user', subjectId: `${agent.id}/someone`, kind: 'memory', statement: 'Private', confidence: 1, evidence: [], projectId: pid } as never, database(), new Date().toISOString());
    expect(memoryItemStates({ id: outsider.id, role: 'member' }, [`agent-user:${agent.id}/someone:memory:x`])).toEqual([]);
  });

  it('gives a reader-only member nothing for a forgotten fact or note, and no reason for a pending forget (blocker)', async () => {
    const { memoryItemStates } = await import('@/lib/server/memory/items');
    const { forgetNote } = await import('@/lib/server/notebook/lifecycle');
    const viewer = await createUser({ email: 'v@items.test', name: 'Viewer', role: 'member', password: 'viewer-password-1' });
    setMember(pid, viewer.id, 'viewer');
    const reader = { id: viewer.id, role: 'member' as const };
    const lead = agentStore.create({ name: 'Lead2' });
    const team = agentTeamStore.create({ name: 'T2', members: [{ id: 'm', kind: 'agent', agentId: lead.id, title: 'Lead' }] });
    setHomeProject('agentTeam', team.id, pid);
    const gone = noteStore.insert({ teamId: team.id, kind: 'fact', text: 'Gone note', scope: 'team', author: 'Lead' });
    const pending = noteStore.insert({ teamId: team.id, kind: 'fact', text: 'Pending note', scope: 'team', author: 'Lead' });
    forgetNote(team.id, gone.id, { reason: 'private reason' }, 'someone');
    forgetNote(team.id, pending.id, { reason: 'later reason', forgetAfter: new Date(Date.now() + 3_600_000).toISOString() }, 'someone');
    const states = memoryItemStates(reader, [`project:${pid}:memory:i0`, `project:${pid}:memory:i1`, gone.id, pending.id]);
    expect(states.map((i) => i.id).sort()).toEqual([`project:${pid}:memory:i0`, pending.id].sort());
    expect(JSON.stringify(states)).not.toMatch(/reason/);
    // A note forgotten "after" a time that has passed is forgotten now, before any sweep (re-review 2).
    const lapsed = noteStore.insert({ teamId: team.id, kind: 'fact', text: 'Lapsed note', scope: 'team', author: 'Lead' });
    forgetNote(team.id, lapsed.id, { reason: 'lapsed reason', forgetAfter: new Date(Date.now() + 3_600_000).toISOString() }, 'someone');
    noteStore.patch(lapsed.id, { expires_at: '2020-01-01T00:00:00.000Z' });
    expect(memoryItemStates(reader, [lapsed.id])).toEqual([]);
    expect(memoryItemStates({ id: editor.id, role: 'member' }, [lapsed.id])).toMatchObject([{ id: lapsed.id, live: false, reason: 'lapsed reason' }]);
    expect(memoryItemStates({ id: editor.id, role: 'member' }, [lapsed.id])[0].text).toBeUndefined();
    // The editor still sees both forgotten items with their reasons.
    const full = memoryItemStates({ id: editor.id, role: 'member' }, [`project:${pid}:memory:i1`, gone.id]);
    expect(full.map((i) => i.reason).sort()).toEqual(['private reason', 'was wrong']);
  });

  it('answers 400 for more than 50 ids', async () => {
    const ids = Array.from({ length: 51 }, (_, i) => `x${i}`).join(',');
    expect((await get(ids)).status).toBe(400);
    expect((await get('')).status).toBe(200);
  });
});
