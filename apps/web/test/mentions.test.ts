/**
 * Tagging with @ (docs/assistant.md#tagging-with-): the search lists only what the caller can open (a second project's
 * workflows, runs and credentials are absent), at most 8 per kind, and a credential hit carries no value; the resolver
 * answers a forbidden and a missing ref the same, holds to 8 refs and 6 KB, gives a data table's sample rows only when
 * asked, wraps the digests as data and masks an email in a run's error; the route refuses an unknown kind; and the
 * picker's pure parts.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Workflow } from '@landflow/engine';
import type { MentionHit, MentionRef } from '@/lib/shared/mentions';

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-mentions-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_AUDIT_OUTBOX: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const projects = await import('@/lib/server/projects');
const { credentials } = await import('@/lib/server/credentials/vault');
const { dataTables } = await import('@/lib/server/datatables');
const { searchMentions } = await import('@/lib/server/mentions/search');
const { resolveMentions, BLOCK_OPEN, BLOCK_CLOSE } = await import('@/lib/server/mentions/resolve');
const { clipBytes } = await import('@/lib/server/mentions/digests');
const route = await import('@/app/api/mentions/route');
const shared = await import('@/lib/shared/mentions');
const { MentionChips, MentionListbox } = await import('@/components/ui/mention-picker');
const { routePolicy } = await import('@/lib/server/auth/policy');

type User = Awaited<ReturnType<typeof createUser>>;
let member: User;
let mineProject = '';
let theirProject = '';
let mineCredential = '';
let theirCredential = '';
let mineTable = '';
let theirTable = '';

const as = async <T>(user: User | undefined, fn: () => Promise<T>): Promise<T> => {
  enableTestAuth(user);
  try {
    return await fn();
  } finally {
    enableTestAuth();
  }
};

function workflow(id: string, name: string, project: string) {
  store.saveWorkflow({ id, name, nodes: [{ id: 'n1', name: 'Fetch', type: 'core.httpRequest', typeVersion: 1, position: [0, 0], parameters: { url: 'https://example.test/api', token: 'secret-value-123' } }], connections: [] } as unknown as Workflow);
  projects.setHomeProject('workflow', id, project);
}

function execution(executionId: string, workflowId: string, workflowName: string, error?: string) {
  const now = new Date().toISOString();
  store.saveExecution({ executionId, workflowId, workflowName, mode: 'manual', status: error ? 'error' : 'success', startedAt: now, finishedAt: now, durationMs: 1200, runData: {}, executionOrder: [], ...(error && { error: { message: error, nodeName: 'Fetch' } }) });
}

beforeAll(async () => {
  registry.registerBuiltin(corePlugin);
  member = await createUser({ email: 'mia@mentions.test', name: 'Mia', role: 'member', password: 'mia-password-1' });
  mineProject = projects.createTeamProject({ name: 'Mine' }).id;
  theirProject = projects.createTeamProject({ name: 'Theirs' }).id;
  projects.setMember(mineProject, member.id, 'editor');
  workflow('wf_inv_mine', 'Invoice sync', mineProject);
  workflow('wf_inv_theirs', 'Invoice secrets', theirProject);
  execution('ex_inv_mine', 'wf_inv_mine', 'Invoice sync', 'Failed for jane.doe@example.com');
  execution('ex_inv_theirs', 'wf_inv_theirs', 'Invoice secrets');
  mineCredential = credentials.create({ name: 'Invoice API', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: 'super-secret-value-abc' } }).id;
  theirCredential = credentials.create({ name: 'Invoice vault', type: 'core.httpHeaderAuth', data: { name: 'X-Key', value: 'other-secret-value-xyz' } }).id;
  projects.setHomeProject('credential', mineCredential, mineProject);
  projects.setHomeProject('credential', theirCredential, theirProject);
  mineTable = dataTables().createTable({ name: 'Invoice rows', columns: [{ name: 'customer', type: 'string' }, { name: 'amount', type: 'number' }], projectId: mineProject }).id;
  theirTable = dataTables().createTable({ name: 'Invoice private', columns: [{ name: 'a', type: 'string' }], projectId: theirProject }).id;
  projects.setHomeProject('dataTable', mineTable, mineProject);
  projects.setHomeProject('dataTable', theirTable, theirProject);
  dataTables().insertRows(mineTable, [{ customer: 'Acme', amount: 12 }, { customer: 'Globex', amount: 30 }]);
});

afterAll(() => {
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const hitsOf = (groups: Awaited<ReturnType<typeof searchMentions>>, type: string) => groups.find((g) => g.type === type)?.items ?? [];

describe('searchMentions', () => {
  it('lists only the workflows, runs, tables and credentials a member of one project can open', async () => {
    const groups = await searchMentions(member, { q: 'inv' });
    expect(hitsOf(groups, 'workflow').map((h) => h.id)).toEqual(['wf_inv_mine']);
    expect(hitsOf(groups, 'run').map((h) => h.id)).toEqual(['ex_inv_mine']);
    expect(hitsOf(groups, 'dataTable').map((h) => h.id)).toEqual([mineTable]);
    expect(hitsOf(groups, 'credential').map((h) => h.id)).toEqual([mineCredential]);
    expect(JSON.stringify(groups)).not.toContain('theirs');
    expect(hitsOf(groups, 'credential').some((h) => h.id === theirCredential)).toBe(false);
    expect(hitsOf(groups, 'dataTable').some((h) => h.id === theirTable)).toBe(false);
  });

  it('shows the owner everything', async () => {
    const groups = await searchMentions({ id: 'owner', role: 'owner' }, { q: 'inv', types: ['workflow', 'credential'] });
    expect(hitsOf(groups, 'workflow').map((h) => h.id).sort()).toEqual(['wf_inv_mine', 'wf_inv_theirs']);
    expect(hitsOf(groups, 'credential')).toHaveLength(2);
  });

  it('gives no value for a credential, only its name and type', async () => {
    const groups = await searchMentions(member, { q: 'invoice api', types: ['credential'] });
    const [hit] = hitsOf(groups, 'credential');
    expect(hit).toEqual({ type: 'credential', id: mineCredential, name: 'Invoice API', hint: 'core.httpHeaderAuth' });
    expect(JSON.stringify(groups)).not.toContain('super-secret');
  });

  it('puts a prefix match first and caps a group at 8', async () => {
    for (let i = 0; i < 12; i++) workflow(`wf_cap_${i}`, `Report ${i}`, mineProject);
    workflow('wf_cap_inside', 'The weekly report', mineProject);
    const items = hitsOf(await searchMentions(member, { q: 'report', types: ['workflow'] }), 'workflow');
    expect(items).toHaveLength(8);
    expect(items[0].name.startsWith('Report')).toBe(true);
    expect(items.every((h) => h.name.startsWith('Report'))).toBe(true);
  });

  it('offers a workflow’s nodes only when it is given and the caller can open it', async () => {
    expect(hitsOf(await searchMentions(member, { types: ['node'] }), 'node')).toEqual([]);
    expect(hitsOf(await searchMentions(member, { types: ['node'], workflowId: 'wf_inv_theirs' }), 'node')).toEqual([]);
    expect(hitsOf(await searchMentions(member, { q: 'fet', types: ['node'], workflowId: 'wf_inv_mine' }), 'node')).toEqual([{ type: 'node', id: 'n1', workflowId: 'wf_inv_mine', name: 'Fetch', hint: 'core.httpRequest' }]);
  });
});

describe('resolveMentions', () => {
  const forbidden: MentionRef = { type: 'workflow', id: 'wf_inv_theirs' };
  const missing: MentionRef = { type: 'workflow', id: 'wf_nobody' };

  it('answers a forbidden and a missing ref the same way', async () => {
    const a = await resolveMentions(member, [{ ...forbidden, name: 'Plan' }]);
    const b = await resolveMentions(member, [{ ...missing, name: 'Plan' }]);
    expect(a.read[0]).toMatchObject({ ok: false, label: 'Couldn\'t read @Plan', summary: '' });
    expect({ ...a.read[0], ref: undefined }).toEqual({ ...b.read[0], ref: undefined });
    expect(a.block).toBe('');
    expect(b.block).toBe('');
    expect((await resolveMentions(member, [forbidden])).read[0].label).toBe("Couldn't read @wf_inv_theirs");
    for (const type of ['run', 'credential', 'dataTable'] as const) {
      const hidden = await resolveMentions(member, [{ type, id: type === 'run' ? 'ex_inv_theirs' : type === 'credential' ? theirCredential : theirTable, name: 'X' }]);
      expect(hidden.read[0]).toMatchObject({ ok: false, label: "Couldn't read @X" });
    }
  });

  it('wraps what it read as data and masks an email in a run’s error', async () => {
    const { block, read } = await resolveMentions(member, [{ type: 'run', id: 'ex_inv_mine' }, { type: 'workflow', id: 'wf_inv_mine' }]);
    expect(read.every((r) => r.ok)).toBe(true);
    expect(block.startsWith(BLOCK_OPEN)).toBe(true);
    expect(block.endsWith(BLOCK_CLOSE)).toBe(true);
    expect(block).toContain('## @Invoice sync run (run)');
    expect(block).toContain('## @Invoice sync (workflow)');
    expect(block).toContain('<email>');
    expect(block).not.toContain('jane.doe@example.com');
  });

  it('never returns a credential value', async () => {
    const { block, read } = await resolveMentions(member, [{ type: 'credential', id: mineCredential }]);
    expect(read[0].ok).toBe(true);
    expect(block).toContain('Invoice API');
    expect(block).not.toContain('super-secret');
    const node = await resolveMentions(member, [{ type: 'node', id: 'n1', workflowId: 'wf_inv_mine' }]);
    expect(node.block).toMatch(/<hidden>|<secret>/);
    expect(node.block).not.toContain('secret-value-123');
  });

  it('gives sample rows only with `samples`', async () => {
    const plain = await resolveMentions(member, [{ type: 'dataTable', id: mineTable }]);
    expect(plain.block).toContain('2 rows');
    expect(plain.block).toContain('customer (string)');
    expect(plain.block).not.toContain('Acme');
    const sampled = await resolveMentions(member, [{ type: 'dataTable', id: mineTable }], { samples: true });
    expect(sampled.block).toContain('Acme');
  });

  it('reads at most 8 refs and 6 KB', async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ type: 'workflow' as const, id: `wf_cap_${i}` }));
    const eight = await resolveMentions(member, many);
    expect(eight.read).toHaveLength(8);
    // Ten big digests: a long description each.
    for (let i = 0; i < 6; i++) store.saveWorkflow({ id: `wf_big_${i}`, name: `Big ${i}`, nodes: Array.from({ length: 40 }, (_, n) => ({ id: `n${n}`, name: `Step ${n}`, type: 'core.set', typeVersion: 1, position: [0, 0], parameters: { text: 'x'.repeat(200) } })), connections: [] } as unknown as Workflow), projects.setHomeProject('workflow', `wf_big_${i}`, mineProject);
    const big = await resolveMentions(member, Array.from({ length: 6 }, (_, i) => ({ type: 'workflow' as const, id: `wf_big_${i}` })));
    expect(Buffer.byteLength(big.block)).toBeLessThanOrEqual(6144 + BLOCK_OPEN.length + BLOCK_CLOSE.length + 8);
    expect(big.read.filter((r) => !r.ok).length).toBeGreaterThan(0);
    expect(big.read[0].ok).toBe(true);
  });

  it('holds each digest to 1.5 KB', async () => {
    const { block } = await resolveMentions(member, [{ type: 'workflow', id: 'wf_big_0' }]);
    expect(Buffer.byteLength(block.split('\n').slice(2, -1).join('\n'))).toBeLessThanOrEqual(1536);
    expect(clipBytes('é'.repeat(2000), 1536).length).toBeLessThan(1536);
  });
});

describe('GET /api/mentions', () => {
  const call = (user: User | undefined, query: string) => as(user, () => (route.GET as (r: Request) => Promise<Response>)(new Request(`http://mentions.test/api/mentions${query}`)));

  it('lists what the member can open, at most 8 per group', async () => {
    const response = await call(member, '?q=inv');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { groups: Array<{ type: string; items: Array<{ id: string }> }> };
    expect(body.groups.find((g) => g.type === 'workflow')?.items.map((i) => i.id)).toEqual(['wf_inv_mine']);
    for (const group of body.groups) expect(group.items.length).toBeLessThanOrEqual(8);
  });

  it('refuses an unknown kind and a long q with 400', async () => {
    expect((await call(member, '?types=workflow,spaceship')).status).toBe(400);
    expect((await call(member, `?q=${'a'.repeat(81)}`)).status).toBe(400);
    expect((await call(member, '?types=workflow,agent')).status).toBe(200);
  });

  it('needs the workflows:read key scope', () => {
    expect(routePolicy('GET', '/api/mentions')).toEqual({ scope: 'workflows:read' });
  });
});

describe('the picker’s pure parts', () => {
  const hit = (type: MentionHit['type'], id: string, name: string): MentionHit => ({ type, id, name });

  it('finds the @query at the caret', () => {
    const { mentionQueryAt } = shared;
    expect(mentionQueryAt('@inv', 4)).toEqual({ start: 0, query: 'inv' });
    expect(mentionQueryAt('check @inv', 10)).toEqual({ start: 6, query: 'inv' });
    expect(mentionQueryAt('check @', 7)).toEqual({ start: 6, query: '' });
    expect(mentionQueryAt('mail me@example.com', 19)).toBeUndefined();
    expect(mentionQueryAt('check @weekly rep', 17)).toEqual({ start: 6, query: 'weekly rep' });
    expect(mentionQueryAt('check @a\nnext', 13)).toBeUndefined();
    expect(mentionQueryAt('hello', 5)).toBeUndefined();
    // The caret before the @ is not in the tag.
    expect(mentionQueryAt('x @inv', 1)).toBeUndefined();
    expect(mentionQueryAt(`@${'a'.repeat(50)}`, 51)).toBeUndefined();
  });

  it('removes the @query text and keeps one space', () => {
    const { removeMentionText } = shared;
    expect(removeMentionText('check @inv now', 6, 10)).toEqual({ value: 'check now', caret: 6 });
    expect(removeMentionText('@inv', 0, 4)).toEqual({ value: '', caret: 0 });
    expect(removeMentionText('why is @in', 7, 10)).toEqual({ value: 'why is ', caret: 7 });
  });

  it('adds a chip once, up to 8, and removes it again', () => {
    const { addChip, removeChip, refOf } = shared;
    const a = hit('workflow', 'w1', 'A');
    let chips = addChip([], a);
    chips = addChip(chips, { ...a });
    expect(chips).toHaveLength(1);
    expect(addChip(chips, { ...a, type: 'agent' })).toHaveLength(2);
    for (let i = 0; i < 12; i++) chips = addChip(chips, hit('agent', `a${i}`, `Agent ${i}`));
    expect(chips).toHaveLength(8);
    expect(removeChip(chips, a)).toHaveLength(7);
    expect(refOf({ ...hit('node', 'n1', 'N'), workflowId: 'w1', hint: 'x' })).toEqual({ type: 'node', id: 'n1', workflowId: 'w1' });
  });

  it('orders the sections: on this page, recent, then the kinds in order, with no tag twice', () => {
    const { pickerSections, flatHits } = shared;
    const local = [hit('node', 'n1', 'Fetch')];
    const recents = [hit('agent', 'a1', 'Fetcher'), hit('workflow', 'w1', 'Fetch flow')];
    const groups = [
      { type: 'agent' as const, items: [hit('agent', 'a1', 'Fetcher'), hit('agent', 'a2', 'Fetch bot')] },
      { type: 'workflow' as const, items: [hit('workflow', 'w1', 'Fetch flow')] },
    ];
    const sections = pickerSections({ local, recents, groups, query: 'fetch' });
    expect(sections.map((s) => s.label)).toEqual(['On this page', 'Recent', 'Agents']);
    expect(flatHits(sections).map((h) => h.id)).toEqual(['n1', 'a1', 'w1', 'a2']);
    const chosen = pickerSections({ local, recents, groups, query: 'fetch', chosen: [hit('agent', 'a1', 'Fetcher')] });
    expect(flatHits(chosen).map((h) => h.id)).toEqual(['n1', 'w1', 'a2']);
  });

  it('keeps the last 8 recents, newest first, and reads back only well-formed ones', () => {
    const { pushRecent, parseRecents, stepActive } = shared;
    let recents: MentionHit[] = [];
    for (let i = 0; i < 10; i++) recents = pushRecent(recents, hit('workflow', `w${i}`, `W${i}`));
    recents = pushRecent(recents, hit('workflow', 'w5', 'W5'));
    expect(recents.map((r) => r.id)).toEqual(['w5', 'w9', 'w8', 'w7', 'w6', 'w4', 'w3', 'w2']);
    expect(parseRecents(JSON.stringify([{ type: 'workflow', id: 'w1', name: 'W1' }, { type: 'bogus', id: 'x', name: 'X' }, 3]))).toEqual([{ type: 'workflow', id: 'w1', name: 'W1' }]);
    expect(parseRecents('not json')).toEqual([]);
    expect(stepActive(0, -1, 3)).toBe(2);
    expect(stepActive(2, 1, 3)).toBe(0);
    expect(stepActive(0, 1, 0)).toBe(0);
  });

  it('draws chips with a remove button and a listbox with options', () => {
    const chips = renderToStaticMarkup(createElement(MentionChips, { chips: [hit('workflow', 'w1', 'Invoice sync')], onRemove: () => undefined }));
    expect(chips).toContain('@Invoice sync');
    expect(chips).toContain('aria-label="Remove @Invoice sync"');
    expect(chips).toContain('max-md:size-11');
    expect(renderToStaticMarkup(createElement(MentionChips, { chips: [], onRemove: () => undefined }))).toBe('');
    const sections = shared.pickerSections({ local: [hit('node', 'n1', 'Fetch')], groups: [{ type: 'agent', items: [{ ...hit('agent', 'a1', 'Helper'), hint: 'Editor' }] }], query: '' });
    const list = renderToStaticMarkup(createElement(MentionListbox, { id: 'lb', sections, activeIndex: 1, onChoose: () => undefined, phone: false }));
    expect(list).toContain('role="listbox"');
    expect(list).toContain('id="lb-opt-0"');
    expect(list).toMatch(/id="lb-opt-1"[^>]*aria-selected="true"/);
    expect(list).toContain('On this page');
    expect(list).toContain('w-[320px]');
  });
});
