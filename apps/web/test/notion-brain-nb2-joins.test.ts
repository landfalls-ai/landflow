/**
 * Wave nb2's joins (backbone/contracts/nb/README.md §6, plan.md §8 J1–J7): NB04's copy and push, NB05's pull and NB06's knowledge
 * walk, each on its real side, over wave nb1's seams. The test loads `@/lib/server/runtime` and nothing else for the brain store,
 * the `notion brain` service, the pull step and the knowledge step (it never imports `lib/server/brain/store`, `pull.ts` or
 * `knowledge.ts` itself, so a missing `runtime.ts` line fails it); it checks that `SERVICES` names `notion brain` before it
 * imports `service.ts` for `tickOnce`. The Notion client is NB02's real `client.ts` (the one the runtime registers; no stub
 * factory) with a `productivity.notionApi` credential whose `baseUrl` is the local fake's URL; routes are called as the
 * synthetic owner; the agent's model is scripted. Nothing here reaches api.notion.com or leaves 127.0.0.1.
 *
 * Each join fails with its seam cut (checked by hand at integration, see docs/history.md): J1 with NB04's outbox listener not
 * registered; J2 with runtime.ts not loading the pull; J3 with the pull drafting a practice as a person's (not `notion`); J4 with
 * the knowledge step not registered; J5 with the push writing through `readClient` instead of the scoped writer; J6 with the
 * service ignoring `LANDFLOW_NOTION_BRAIN`; J7 with a copy that drifts from the contracts folder.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import { defineCredentialType, definePlugin } from '@landflow/sdk';
import { FAKE_NOTION_TOKEN, startFakeNotion, type FakeNotion } from './fake-notion';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-nb2-joins-'));
const ENV = {
  LANDFLOW_DATA_DIR: dataDir,
  LANDFLOW_REGISTRY_GRPC_PORT: 'off',
  LANDFLOW_SCAN_ON_START: 'false',
  LANDFLOW_PLUGINS: '',
  LANDFLOW_AUDIT_OUTBOX: 'off',
  LANDFLOW_BRAIN_MODEL: 'off',
  LANDFLOW_BRAIN_EMBEDDINGS: 'off',
  LANDFLOW_PUBLIC_URL: 'http://nb2-joins.test',
};
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

// The agent's model is scripted (J4): each call takes the next step.
type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn>;
const script: Step[] = [];
const seenTools: string[][] = [];
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (config: { model?: string } | undefined): LanguageModel => {
    if (!config?.model) throw new Error('Choose a model for this agent first');
    return {
      provider: 'scripted',
      model: config.model,
      async generate(input) {
        seenTools.push(input.tools.map((t) => t.name));
        const step = script.shift();
        return { text: 'ok', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, ...step?.(input as never) };
      },
    };
  },
}));

// The real sides, through the runtime only.
const runtime = await import('@/lib/server/runtime');
const { brainStoreFor } = await import('@/lib/server/brain/store/port');
const { NOTION_VERSION } = await import('@/lib/server/notion/port');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createUser } = await import('@/lib/server/auth/users');
const { withAuth } = await import('@/lib/server/auth/context');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const projectsStore = await import('@/lib/server/projects/store');
const { database } = await import('@/lib/server/db');
const { logger } = await import('@/lib/server/telemetry');
const entities = await import('@/lib/server/brain/entities');
const facts = await import('@/lib/server/brain/facts');
const { listProposals } = await import('@/lib/server/brain/proposals');
const practices = await import('@/lib/server/practices/store');
const approve = await import('@/lib/server/practices/approve');
const { selectForRun } = await import('@/lib/server/practices/context-source');
const { noteStore } = await import('@/lib/server/notebook/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { agentTeamStore } = await import('@/lib/server/agent-teams/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { agentConnections } = await import('@/lib/server/agents/connections');
const { projectAgentRules } = await import('@/lib/server/project-context/project-settings');
const { store } = await import('@/lib/server/store');
const { saveKind } = await import('@/lib/server/usage/kinds');
const { recordUsage } = await import('@/lib/server/usage/ledger');
const links = await import('@/lib/server/brain/notion/links');
const sync = await import('@/lib/server/brain/notion/sync');
const { LANDFLOW_ID, brainPageTitle } = await import('@/lib/shared/notion-brain');
const { NOTION_EVIDENCE_LABEL } = await import('@/lib/shared/brain');
const linkRoute = await import('@/app/api/projects/[id]/brain/notion/route');
const syncRoute = await import('@/app/api/projects/[id]/brain/notion/sync/route');
const entityRoute = await import('@/app/api/entities/[type]/[id]/route');
const entityFactsRoute = await import('@/app/api/entities/[type]/[id]/facts/route');
const askRoute = await import('@/app/api/brain/ask/route');
const approveRoute = await import('@/app/api/practices/[id]/approve/route');
const settingsRoute = await import('@/app/api/projects/[id]/settings/route');

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
    info: { id: 'productivity', name: 'Productivity (stand-in)', version: '0.0.0', language: 'typescript' },
    nodes: [],
    credentialTypes: [
      defineCredentialType({
        name: 'notionApi',
        displayName: 'Notion API',
        properties: [
          { name: 'apiKey', displayName: 'Internal Integration Secret', type: 'string', required: true, typeOptions: { password: true } },
          { name: 'baseUrl', displayName: 'API Base URL', type: 'string', default: 'https://api.notion.com' },
        ],
      }),
    ],
  }),
);

const PROJECT = 'Payments nb2';
let service: typeof import('@/lib/server/brain/notion/service');
let fake: FakeNotion;
let offset = 0; // the fake's clock runs ahead by whole minutes, so a person's edit lands in a later minute than the bot's
let projectId = '';
let credential = '';
let linkId = '';
let approvedPractice = '';
const logged: string[] = [];

const rt = (content: string) => ({ rich_text: [{ type: 'text', text: { content } }] });
const titleOf = (content: string) => ({ title: [{ type: 'text', text: { content } }] });
const select = (name: string) => ({ select: { name } });
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const nextMinute = () => void (offset += 60_000);
const asPerson = <T>(fn: () => T): T => withAuth({ principal: { user: TEST_OWNER, via: 'test' } }, fn);
const link = () => links.linkById(linkId)!;
const rowOf = (kind: 'entity' | 'fact' | 'practice' | 'note', key: string) => sync.itemOf(linkId, kind, key)!.notion_id;
const mark = () => fake.state.requests.length;
const writesSince = (m: number) => fake.state.requests.slice(m).filter((r) => (r.method === 'POST' || r.method === 'PATCH') && !r.template.endsWith('/query'));
const compact = (id: string) => id.replace(/-/g, '');
const req = (method: string, url: string, body?: unknown) => new Request(`http://nb2-joins.test${url}`, { method, ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
async function call(fn: () => Promise<Response>) {
  const response = await fn();
  const text = await response.text();
  return { status: response.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

/** One tick of the real service, after the brain changes that came before it were heard. */
async function tick() {
  await flush();
  service.resetBackoff();
  await service.tickOnce();
  await flush();
}
/** Sync now (the route an admin uses), then one tick: the pull and the knowledge walk run. */
async function syncNow() {
  const asked = await call(() => syncRoute.POST(req('POST', `/api/projects/${projectId}/brain/notion/sync`), params({ id: projectId })));
  expect(asked.status).toBe(202);
  await tick();
}

beforeAll(async () => {
  fake = await startFakeNotion({ botName: 'Landflow nb2 bot', workspaceName: 'Joins workspace', now: () => Date.now() + offset });
  for (const level of ['warn', 'info', 'error', 'debug'] as const) {
    const real = logger[level].bind(logger);
    vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (real as (...a: unknown[]) => unknown)(...args);
    }) as never);
  }

  // The project: 2 customers, 1 person, 1 system, 3 facts (one about a customer), an approved and a draft project practice,
  // a project note, and private work.
  const member = await createUser({ email: 'member@nb2-joins.test', name: 'Member', role: 'member', password: 'member-password-1' });
  projectId = projectsStore.createTeamProject({ name: PROJECT }).id;
  const make = (type: string, id: string, name: string, extra: Record<string, unknown> = {}) => entities.upsertEntity({ type, id, name, projectId, ...extra }).entity;
  make('customer', 'kestrel-bank', 'Kestrel Bank', { description: 'A bank' });
  make('customer', 'harbor-air', 'Harbor Air', { description: 'An airline' });
  make('person', 'ana', 'Ana', { attrs: { department: 'Sales' } });
  make('system', 'ledger-api', 'Ledger API', { description: 'The ledger' });
  facts.upsertFact({ subjectType: 'entity', subjectId: 'customer/kestrel-bank', subjectName: 'Kestrel Bank', kind: 'health', statement: 'Kestrel renews in March', evidence: [], confidence: 0.8, projectId });
  facts.upsertFact({ subjectType: 'entity', subjectId: 'system/ledger-api', subjectName: 'Ledger API', kind: 'dependency', statement: 'The ledger needs the billing queue', evidence: [], confidence: 0.8, projectId });
  facts.upsertFact({ subjectType: 'entity', subjectId: 'person/ana', subjectName: 'Ana', kind: 'purpose', statement: 'Ana runs the renewals', evidence: [], confidence: 0.8, projectId });
  const person = { source: 'person' as const, actor: { id: TEST_OWNER.id, role: 'owner' as const } };
  const draftOf = (handle: string, title: string) => ({ handle, title, level: 'project' as const, projectId, strength: 'required' as const, topics: ['helm'], repos: [], paths: ['deploy/**'], summary: `${title} summary`, body: `Rules for ${title}.\n\n- one chart per service` });
  const first = asPerson(() => practices.draftPractice(draftOf('team/charts', 'Charts live under deploy/helm'), person));
  approve.approvePractice({ id: TEST_OWNER.id, role: 'owner' }, first.practice.id, { version: 1, reviewedSources: true, conflicts: {} });
  approvedPractice = first.practice.id;
  asPerson(() => practices.draftPractice({ ...draftOf('team/reviews', 'Reviews need two people'), topics: ['review'], paths: ['src/**'] }, person));
  const lead = agentStore.create({ name: 'Lead' });
  const team = agentTeamStore.create({ name: 'Payments team', members: [{ id: 'm_lead', kind: 'agent', agentId: lead.id, title: 'Lead' }] });
  projectsStore.setHomeProject('agentTeam', team.id, projectId);
  noteStore.insert({ teamId: team.id, projectId, kind: 'fact', text: 'Billing closes on the 5th', author: 'm_lead', scope: 'project' });
  const flow = store.saveWorkflow({ id: 'wf_nb2_joins', name: 'Ingest work', active: false, nodes: [], connections: [], createdBy: member.id } as never, { actor: member.id });
  projectsStore.setHomeProject('workflow', flow.id, projectId);
  saveKind({ kind: 'work.call_held', fields: ['source', 'sourceId', 'url', 'actor', 'title', 'summary', 'team', 'initiative', 'customer', 'occurredAt'].map((name) => ({ name, type: 'string' as const, required: false })) });
  const at = new Date(Date.now() - 3_600_000).toISOString();
  recordUsage({ kind: 'work.call_held' as never, workflowId: flow.id, at, ownerId: member.id, visibility: 'private', attrs: { source: 'fathom', sourceId: 's-private', title: 'SECRET private roadmap review', summary: 'private', actor: 'member@nb2-joins.test', customer: 'Kestrel Bank', occurredAt: at } } as never);

  credential = credentials.create({ name: 'Notion nb2 key', type: 'productivity.notionApi', data: { apiKey: FAKE_NOTION_TOKEN, baseUrl: fake.url } }).id;
  projectsStore.replaceShares('credential', credential, [{ projectId, role: 'user' }]);
  const root = fake.addPage({ title: 'Payments wiki', shared: true });

  // The service is the runtime's: it must be in SERVICES before its module is used for ticks.
  expect(runtime.SERVICES.map((s) => s.name)).toContain('notion brain');
  expect(runtime.SERVICES.find((s) => s.name === 'notion brain')).toMatchObject({ leader: true });
  service = await import('@/lib/server/brain/notion/service');

  const made = await call(() => linkRoute.POST(req('POST', `/api/projects/${projectId}/brain/notion`, { credentialId: credential, page: root, rps: 8 }), params({ id: projectId })));
  expect(made.status).toBe(202);
  linkId = links.getLink(projectId)!.id;
  for (let i = 0; i < 5 && link().status !== 'active'; i++) await tick();
  expect(link().status).toBe('active');
  expect(fake.value(rowOf('entity', 'customer/kestrel-bank'), 'Name')).toBe('Kestrel Bank');
  // A first pull and knowledge pass (the baseline), then whatever they queued is pushed.
  await syncNow();
  await tick();
});

afterAll(async () => {
  vi.restoreAllMocks();
  await fake?.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
  delete process.env.LANDFLOW_NOTION_BRAIN;
});

describe('J1: a Brain-page edit reaches the fake’s row (NB01 feed → NB04 listener, outbox, push)', () => {
  it('a description changed through the entity route is one PATCH of its row on the next tick, with no Markdown write', async () => {
    const row = rowOf('entity', 'customer/kestrel-bank');
    const patched = await call(() => entityRoute.PATCH(req('PATCH', '/api/entities/customer/kestrel-bank', { description: 'A bank in Leeds' }), params({ type: 'customer', id: 'kestrel-bank' })));
    expect(patched.status).toBe(200);
    await flush();
    expect(database().all<{ kind: string; local_key: string }>('SELECT kind, local_key FROM notion_brain_outbox WHERE link_id = ? AND kind = ?', linkId, 'entity')).toEqual([{ kind: 'entity', local_key: 'customer/kestrel-bank' }]);
    const m = mark();
    await tick();
    expect(fake.value(row, 'Description')).toBe('A bank in Leeds');
    const writes = writesSince(m);
    expect(writes.map((w) => `${w.method} ${w.template}`)).toEqual(['PATCH /v1/pages/:id']);
    expect(compact(writes[0].path)).toContain(compact(row));
    expect(writes.some((w) => w.template.includes('markdown'))).toBe(false);
    // Every request the real client made carried the contract's version (the fake refuses one that does not).
    expect(NOTION_VERSION).toBe('2026-03-11');
    expect(fake.state.requests.slice(m).every((r) => r.status === 200)).toBe(true);
  });
});

describe('J2: a fact a person adds in the fake becomes a fact Ask finds (NB05 → brainStoreFor → searchFacts → Ask)', () => {
  it('a Facts row about the customer is pulled on Sync now, gets its Landflow ID back, and Ask lists it', async () => {
    const dbs = sync.linkDatabases(link());
    const customerRow = rowOf('entity', 'customer/kestrel-bank');
    nextMinute();
    const row = fake.addRow(dbs.facts!.databaseId, { Statement: titleOf('Kestrel pays by wire only'), Kind: select('purpose'), About: { relation: [{ id: customerRow }] } });
    await syncNow();
    const found = facts.searchFacts('wire', {});
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ statement: 'Kestrel pays by wire only', subjectId: 'customer/kestrel-bank', projectId });
    expect(found[0].evidence).toEqual([expect.objectContaining({ label: NOTION_EVIDENCE_LABEL, href: expect.stringContaining(compact(row)) })]);
    expect(fake.value(row, LANDFLOW_ID)).toBe(found[0].id);
    const asked = await call(() => askRoute.POST(req('POST', '/api/brain/ask', { question: 'Does Kestrel pay by wire?' })));
    expect(asked.status).toBe(200);
    expect((asked.body.facts as Array<{ statement: string }>).map((f) => f.statement)).toContain('Kestrel pays by wire only');
  });
});

describe('J3: a practice edited in the fake is a tainted draft the agent prompt does not carry until approved (NB05 → practices → selectForRun)', () => {
  it('version 2 from notion waits for approval with its review; the fake shows the approved text with the callout meanwhile', async () => {
    const row = rowOf('practice', approvedPractice);
    const parts = sync.splitBody(fake.body(row)!);
    expect(parts.region).toContain('> Charts live under deploy/helm summary');
    expect(parts.region).toContain('Rules for Charts live under deploy/helm.');
    // A person rewrites the summary (the line the agent prompt carries) and adds a rule.
    nextMinute();
    const edited = parts.region!.replace('> Charts live under deploy/helm summary', '> Pin the chart version of every service');
    fake.editAsPerson(row, { markdown: sync.pageBody(`${edited}\nAlso pin the chart version.`, parts.notes) });
    await syncNow();
    const versions = practices.versionsOf(approvedPractice);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]).toMatchObject({ source: 'notion', tainted: true });
    expect(versions[0].body).toContain('Also pin the chart version.');
    expect(versions[0].summary).toBe('Pin the chart version of every service');
    const suggestion = listProposals({ status: 'open', limit: 100 }).find((p) => p.practice?.practiceId === approvedPractice && p.practice.version === 2);
    expect(suggestion).toBeDefined();
    // The agent prompt's practices are still version 1's.
    const before = selectForRun({ projectId, size: 'full' });
    expect(before.practices).toContainEqual({ handle: 'team/charts', version: 1 });
    expect(before.text).toContain('Charts live under deploy/helm summary');
    expect(before.text).not.toContain('Pin the chart version of every service');
    // The next tick writes the approved text back, with the callout, before anyone approves.
    await tick();
    const shown = fake.body(row)!;
    expect(shown).toContain('Your change is draft v2, waiting for approval in Landflow');
    expect(sync.splitBody(shown).region).not.toContain('Also pin the chart version');
    expect(sync.splitBody(shown).region).toContain('> Charts live under deploy/helm summary');
    // Approving needs the review of its sources.
    const refused = await call(() => approveRoute.POST(req('POST', `/api/practices/${approvedPractice}/approve`, { version: 2 }), params({ id: approvedPractice })));
    expect(refused.status).toBe(409);
    expect(selectForRun({ projectId, size: 'full' }).text).not.toContain('Pin the chart version of every service');
    const approved = await call(() => approveRoute.POST(req('POST', `/api/practices/${approvedPractice}/approve`, { version: 2, reviewedSources: true }), params({ id: approvedPractice })));
    expect(approved.status).toBe(200);
    const after = selectForRun({ projectId, size: 'full' });
    expect(after.practices).toContainEqual({ handle: 'team/charts', version: 2 });
    expect(after.text).toContain('Pin the chart version of every service');
  });
});

describe('J4: a knowledge page in the fake is the project knowledge tool’s passage in an agent run (NB06 → agents runtime)', () => {
  it('a page under the brain page, indexed on Sync now, is what project_knowledge returns, and the connection names the brain page', async () => {
    const brain = link().brain_page_id!;
    nextMinute();
    const refund = fake.addPage({ parentId: brain, title: 'Refund policy', markdown: 'Customers may ask for a refund within 30 days of purchase. After the refund window we give store credit.' });
    const saved = await call(() => settingsRoute.PATCH(req('PATCH', `/api/projects/${projectId}/settings`, { knowledge: { enabled: true, tool: { source: 'notion-brain' } } }), params({ id: projectId })));
    expect(saved.status).toBe(200);
    await syncNow();
    const agent = agentStore.create({ name: 'Support', instructions: 'Help.', model: { provider: 'ollama', model: 'm1' } } as never);
    projectsStore.setHomeProject('agent', agent.id, projectId);
    let result = '';
    seenTools.length = 0;
    script.push(
      () => ({ text: '', toolCalls: [{ id: 'c1', name: 'project_knowledge', input: { query: 'refund window' } }], stopReason: 'tool_use' }),
      (input) => {
        result = JSON.stringify([...input.messages].reverse().find((m) => m.role === 'tool'));
        return { text: 'Thirty days.' };
      },
    );
    const session = newSession(agentStore.get(agent.id)!, { source: 'test', userId: 'you', version: 'draft' });
    const outcome = await runAgent({ agent: agentStore.get(agent.id)!, session, message: 'What is our refund window?', context: { caller: 'chat' as const, agentId: agent.id, projectId } } as never);
    expect(outcome.session.timeline.some((e: { type: string }) => e.type === 'error')).toBe(false);
    expect(seenTools[0]).toContain('project_knowledge');
    expect(result).toContain('refund within 30 days');
    expect(result).toContain('Refund policy');
    expect(compact(result)).toContain(compact(refund));
    const connection = agentConnections(agentStore.get(agent.id)!, {}, { project: projectAgentRules(projectId)! }).find((c) => c.from === 'project');
    expect(connection).toMatchObject({ kind: 'knowledge', name: `Notion · ${brainPageTitle(PROJECT)}` });
  });
});

describe('J5: the scoped writer refuses a write outside the root, end to end through the push (NB02 → sync.ts → NB04)', () => {
  it('a row pointed at a page under another shared root is never written; the next object in the same tick lands', async () => {
    const stranger = fake.addPage({ title: 'Stranger root', shared: true });
    const outside = fake.addPage({ parentId: stranger, title: 'X', markdown: 'secret' });
    const item = sync.itemOf(linkId, 'entity', 'customer/kestrel-bank')!;
    database().upsert('notion_brain_items', { ...item, notion_id: outside } as never); // "by SQL": the items table alone now names X
    sync.forgetLink(linkId);
    try {
      expect((await call(() => entityRoute.PATCH(req('PATCH', '/api/entities/customer/kestrel-bank', { description: 'Changed on the Brain page' }), params({ type: 'customer', id: 'kestrel-bank' })))).status).toBe(200);
      expect((await call(() => entityRoute.PATCH(req('PATCH', '/api/entities/customer/harbor-air', { description: 'An airline in Bristol' }), params({ type: 'customer', id: 'harbor-air' })))).status).toBe(200);
      const m = mark();
      await tick();
      expect(fake.writes().filter((w) => compact(w.path).includes(compact(outside)))).toEqual([]);
      expect(fake.state.requests.slice(m).filter((r) => compact(r.path).includes(compact(outside)) && r.method !== 'GET')).toEqual([]);
      expect(logged.some((line) => line.includes(`[notion-brain] refused write ${outside}`))).toBe(true);
      const stuck = database().get<{ last_error: string | null }>('SELECT last_error FROM notion_brain_outbox WHERE link_id = ? AND kind = ? AND local_key = ?', linkId, 'entity', 'customer/kestrel-bank');
      expect(stuck?.last_error).toBeTruthy();
      expect(fake.body(outside)).toBe('secret');
      expect(fake.value(rowOf('entity', 'customer/harbor-air'), 'Description')).toBe('An airline in Bristol');
    } finally {
      database().upsert('notion_brain_items', { ...sync.itemOf(linkId, 'entity', 'customer/kestrel-bank')!, notion_id: item.notion_id } as never);
      sync.forgetLink(linkId);
      database().delete('notion_brain_outbox', { link_id: linkId, kind: 'entity', local_key: 'customer/kestrel-bank' });
    }
  });
});

describe('J6: with LANDFLOW_NOTION_BRAIN=off nothing is called and the local brain behaves as before', () => {
  it('an edit, a fact and Ask work locally with no request; switched on, one tick pushes what changed', async () => {
    await tick();
    process.env.LANDFLOW_NOTION_BRAIN = 'off';
    let factId = '';
    try {
      const m = mark();
      expect(brainStoreFor(projectId).backend).toBe('local');
      expect((await call(() => entityRoute.PATCH(req('PATCH', '/api/entities/person/ana', { description: 'Ana while off' }), params({ type: 'person', id: 'ana' })))).status).toBe(200);
      const added = await call(() => entityFactsRoute.POST(req('POST', '/api/entities/system/ledger-api/facts', { kind: 'health', statement: 'The ledger is green while off' }), params({ type: 'system', id: 'ledger-api' })));
      expect(added.status).toBe(201);
      factId = (added.body.fact as { id: string } | undefined)?.id ?? facts.searchFacts('green', {})[0].id;
      const asked = await call(() => askRoute.POST(req('POST', '/api/brain/ask', { question: 'Is the ledger green?' })));
      expect(asked.status).toBe(200);
      expect((asked.body.facts as Array<{ statement: string }>).map((f) => f.statement)).toContain('The ledger is green while off');
      for (let i = 0; i < 10; i++) await tick();
      expect(fake.state.requests.length).toBe(m);
      expect(entities.getEntity('person', 'ana')!.description).toBe('Ana while off');
      expect(facts.searchFacts('green', {}).map((f) => f.statement)).toEqual(['The ledger is green while off']);
      // The outbox kept filling.
      const waiting = database().all<{ kind: string; local_key: string }>("SELECT kind, local_key FROM notion_brain_outbox WHERE link_id = ? AND kind IN ('entity', 'fact')", linkId);
      expect(waiting).toEqual(expect.arrayContaining([{ kind: 'entity', local_key: 'person/ana' }, { kind: 'fact', local_key: factId }]));
    } finally {
      delete process.env.LANDFLOW_NOTION_BRAIN;
    }
    expect(brainStoreFor(projectId).backend).toBe('notion');
    await tick();
    expect(fake.value(rowOf('entity', 'person/ana'), 'Description')).toBe('Ana while off');
    expect(fake.value(rowOf('fact', factId), 'Statement')).toBe('The ledger is green while off');
  });
});

describe('the key stays in the vault', () => {
  it('no stored link, item or captured log line holds the key', () => {
    expect(JSON.stringify(database().all('SELECT * FROM notion_brain_links'))).not.toContain(FAKE_NOTION_TOKEN);
    expect(JSON.stringify(database().all('SELECT * FROM notion_brain_outbox'))).not.toContain(FAKE_NOTION_TOKEN);
    expect(logged.join('\n')).not.toContain(FAKE_NOTION_TOKEN);
  });
});

describe('J7: the contract copies', () => {
  it.skipIf(!process.env.LANDFLOW_BACKBONE_CONTRACTS)('sync.ts, the four render fixtures and the five nb1 copies equal backbone/contracts/nb byte for byte', () => {
    const dir = join(process.env.LANDFLOW_BACKBONE_CONTRACTS!, 'nb');
    const src = join(__dirname, '..', 'src', 'lib');
    const same = (copy: string, contract: string) => expect(readFileSync(copy, 'utf8'), contract).toBe(readFileSync(join(dir, contract), 'utf8'));
    same(join(src, 'server', 'brain', 'notion', 'sync.ts'), 'sync.ts');
    for (const file of ['input.ts', 'kestrel-bank.md', 'ana.md', 'home.md']) same(join(__dirname, 'fixtures', 'notion-render', file), join('render-fixtures', file));
    same(join(src, 'shared', 'brain-store.ts'), 'brain-store.ts');
    same(join(src, 'server', 'brain', 'store', 'port.ts'), 'brain-store-port.ts');
    same(join(src, 'server', 'notion', 'port.ts'), 'notion-port.ts');
    same(join(__dirname, 'fake-notion.ts'), 'fake-notion.ts');
    same(join(src, 'shared', 'notion-brain.ts'), 'notion-brain.ts');
  });
});
