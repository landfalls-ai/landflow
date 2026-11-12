/**
 * Entities in the second brain (docs/second-brain.md#entities): the registry, facts and suggestions about an entity, the
 * Entity node, Find Similar and the walls around other projects, the study, and the routes. No model, no embeddings.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-entities-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { createUser } = await import('@/lib/server/auth/users');
const entities = await import('@/lib/server/brain/entities');
const facts = await import('@/lib/server/brain/facts');
const proposals = await import('@/lib/server/brain/proposals');
const { study } = await import('@/lib/server/brain/study');
const { brainStatus } = await import('@/lib/server/brain');
const { findSimilar } = await import('@/lib/server/brain/similar');
const { scopeForActor } = await import('@/lib/server/brain/scope');
const { brainEntityNode } = await import('@/lib/server/nodes/entities');
const { landflowUsageNode, suggestImprovementNode } = await import('@/lib/server/nodes/usage');
const { instanceServer } = await import('@/lib/server/mcp/instance-tools');
const { createTeamProject, setHomeProject, setMember } = await import('@/lib/server/projects/store');
const { analystConfig } = await import('@/lib/server/brain/analyst');
const { runOk } = await import('./helpers');
const entitiesRoute = await import('@/app/api/entities/route');
const entityRoute = await import('@/app/api/entities/[type]/[id]/route');
const entityFactsRoute = await import('@/app/api/entities/[type]/[id]/facts/route');
const proposalsRoute = await import('@/app/api/proposals/route');
const proposalRoute = await import('@/app/api/proposals/[id]/route');
const factsRoute = await import('@/app/api/brain/facts/route');

registry.registerBuiltin(corePlugin);
const owner = await createUser({ email: 'owner@entities.test', name: 'Owner', role: 'owner', password: 'owner-password-1' });
const alice = await createUser({ email: 'alice@entities.test', name: 'Alice', role: 'member', password: 'alice-password-1' });
const alpha = createTeamProject({ name: 'Alpha', createdBy: owner.id });
const beta = createTeamProject({ name: 'Beta', createdBy: owner.id });
setMember(alpha.id, alice.id, 'editor');
const aliceActor = { id: alice.id, role: 'member' as const };

afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

async function call(handler: unknown, url: string, init: RequestInit & { json?: unknown } = {}, params?: Record<string, string>) {
  const { json: body, ...rest } = init;
  const request = new Request(`http://localhost${url}`, { ...rest, ...(body !== undefined && { method: rest.method ?? 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(request, params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, any> };
}

function clear() {
  const db = database();
  for (const [table, column] of Object.entries({ proposals: 'created_at', brain_facts: 'last_seen', brain_profiles: 'updated_at', brain_entities: 'created_at' } as const)) db.deleteBefore(table as 'proposals', column, '9999');
  for (const w of store.listWorkflows()) store.deleteWorkflow(w.id);
}

function asker(id = 'wf_test', createdBy: string = alice.id, project = alpha.id) {
  const node: WorkflowNode = { id: 'n1', name: 'Entity', type: 'core.brainEntity', typeVersion: 1, position: [0, 0], parameters: {} };
  const w = store.saveWorkflow({ id, name: 'Asker', active: false, nodes: [node], connections: [], createdBy } as Workflow);
  setHomeProject('workflow', w.id, project);
  return w;
}

/** An initiative in Alpha, and one in Beta that Alice cannot open. */
function seed() {
  const mine = entities.upsertEntity({ type: 'initiative', id: 'invoice-reminders', name: 'Invoice reminders', description: 'Remind customers of unpaid invoices every week', owner: alice.id, projectId: alpha.id, attrs: { team: 'billing' } }).entity;
  const theirs = entities.upsertEntity({ type: 'initiative', id: 'overdue-nagger', name: 'Overdue invoice nagger', description: 'Remind customers about unpaid invoices by email.\nBudget code sk-hidden', owner: 'Collections team', projectId: beta.id }).entity;
  return { mine, theirs };
}

beforeEach(clear);

describe('the registry', () => {
  it('creates, merges updates, filters and deletes with what is known about it', () => {
    const { entity, created } = entities.upsertEntity({ type: 'customer', name: 'Acme Corp', owner: 'Sales', attrs: { tier: 'gold', seats: 40 } });
    expect(created).toBe(true);
    expect(entity.id).toMatch(/^acme-corp-[0-9a-f]{4}$/);
    const again = entities.upsertEntity({ type: 'customer', id: entity.id, attrs: { tier: null, region: 'eu' } });
    expect(again.created).toBe(false);
    expect(again.entity).toMatchObject({ name: 'Acme Corp', owner: 'Sales', attrs: { seats: 40, region: 'eu' } });
    expect(again.entity.attrs).not.toHaveProperty('tier');
    entities.upsertEntity({ type: 'system', id: 'crm', name: 'CRM', owner: alice.id });
    expect(entities.listEntities({ type: 'customer' }).map((e) => e.name)).toEqual(['Acme Corp']);
    expect(entities.listEntities({ owner: 'Alice' }).map((e) => e.id)).toEqual(['crm']);
    expect(entities.listEntities({ text: 'gold' })).toEqual([]);
    expect(entities.listEntities({ text: 'acme eu' })).toHaveLength(1);
    expect(entities.listEntities({ text: 'seats 40' })).toEqual([]);

    const fact = entities.addEntityFact(again.entity, { kind: 'dependency', statement: 'Depends on the CRM' });
    expect(fact).toMatchObject({ subjectType: 'entity', subjectId: `customer/${entity.id}`, subjectName: 'Acme Corp' });
    expect(entities.deleteEntity('customer', entity.id)).toBe(true);
    expect(facts.listFacts({ subjectType: 'entity', subjectId: `customer/${entity.id}` })).toEqual([]);
    expect(entities.deleteEntity('customer', entity.id)).toBe(false);
  });

  it('refuses a bad type, id, attribute and a nameless entity', () => {
    expect(() => entities.upsertEntity({ type: 'team', name: 'X' })).toThrow(/Unknown entity type/);
    expect(() => entities.upsertEntity({ type: 'person', id: 'Bad/Id', name: 'X' })).toThrow(/entity id/);
    expect(() => entities.upsertEntity({ type: 'person', name: 'X', attrs: { 'bad name': 1 } })).toThrow(/attribute name/);
    expect(() => entities.upsertEntity({ type: 'person', name: 'X', attrs: { nested: { a: 1 } } })).toThrow(/text, a number/);
    expect(() => entities.upsertEntity({ type: 'person' })).toThrow(/needs a name/);
  });

  it('shows an entity to the members of its project only', () => {
    const { mine, theirs } = seed();
    const scope = scopeForActor(aliceActor)!;
    expect([...scope.entities!]).toEqual(['initiative/invoice-reminders']);
    expect(entities.canEntity(aliceActor, mine, 'read')).toBe(true);
    expect(entities.canEntity(aliceActor, mine, 'update')).toBe(true);
    expect(entities.canEntity(aliceActor, theirs, 'read')).toBe(false);
    expect(entities.listEntities({ scope }).map((e) => e.id)).toEqual(['invoice-reminders']);
    expect(scopeForActor({ id: owner.id, role: 'owner' })).toBeUndefined();
  });
});

describe('facts and suggestions about an entity', () => {
  it('scopes facts by entity, keeps added facts through the study and finds them by words', async () => {
    const { mine, theirs } = seed();
    entities.addEntityFact(mine, { kind: 'quality', statement: 'Customers opened the reminder emails less after the redesign' });
    entities.addEntityFact(theirs, { kind: 'quality', statement: 'Customers opened the nagger emails often' });
    const scope = scopeForActor(aliceActor);
    expect(facts.listFacts({ subjectType: 'entity', scope }).map((f) => f.subjectName)).toEqual(['Invoice reminders']);
    expect(facts.searchFacts('emails redesign', { scope }).map((f) => f.subjectId)).toEqual(['initiative/invoice-reminders']);
    const result = await study({ embed: false });
    expect(result.entities).toBe(2);
    expect(facts.listFacts({ subjectType: 'entity', subjectId: 'initiative/invoice-reminders', kind: 'quality' })).toHaveLength(1);
    // A later study doesn't stale it away.
    await study({ embed: false, now: Date.now() + 86_400_000 });
    expect(facts.listFacts({ subjectType: 'entity', subjectId: 'initiative/invoice-reminders', kind: 'quality', status: 'active' })).toHaveLength(1);
  });

  it('profiles an entity from what is on file, without a model', async () => {
    const { mine } = seed();
    entities.addEntityFact(mine, { kind: 'change', statement: 'Moved to Fridays' });
    await study({ embed: false });
    expect(facts.getProfile('entity', 'initiative/invoice-reminders')).toMatchObject({ name: 'Invoice reminders', purpose: 'Remind customers of unpaid invoices every week', projectId: alpha.id });
    const purpose = facts.listFacts({ subjectType: 'entity', subjectId: 'initiative/invoice-reminders', kind: 'purpose' });
    expect(purpose[0].statement).toMatch(/initiative “Invoice reminders” owned by Alice.*team: billing/);
    expect(facts.listFacts({ subjectType: 'entity', subjectId: 'initiative/invoice-reminders', kind: 'usage' })[0].statement).toMatch(/1 statement on file/);
    expect(brainStatus().entities).toBe(2);
  });

  it('turns an entity suggestion into a card target, scopes it, and learns from "it is intended"', () => {
    const { mine, theirs } = seed();
    const made = proposals.proposeFrom({ title: 'Merge with the nagger', why: 'Same job', entity: { type: 'initiative', id: mine.id } }, 'analyst')!;
    expect(made.target).toEqual({ type: 'entity', id: 'initiative/invoice-reminders', name: 'Invoice reminders' });
    expect(made.projectId).toBe(alpha.id);
    proposals.proposeFrom({ title: 'Retire it', why: 'Unused', entity: { type: 'initiative', id: theirs.id } }, 'analyst');
    expect(proposals.listProposals({ scope: scopeForActor(aliceActor) }).map((p) => p.title)).toEqual(['Merge with the nagger']);
    expect(proposals.listProposals({}).length).toBe(2);
    expect(() => proposals.proposeFrom({ title: 'x', why: 'y', entity: { type: 'initiative', id: 'nope' } }, 'analyst')).toThrow(/No initiative nope/);

    proposals.dismissProposal(made.id, 'intended', { note: 'on purpose' });
    const intended = facts.listFacts({ subjectType: 'entity', subjectId: 'initiative/invoice-reminders', kind: 'intended' });
    expect(intended).toHaveLength(1);
    expect(intended[0]).toMatchObject({ subjectName: 'Invoice reminders', projectId: alpha.id });
    // Never suggested again.
    expect(proposals.proposeFrom({ title: 'Merge with the nagger', why: 'Same job', entity: { type: 'initiative', id: mine.id } }, 'analyst')).toBeUndefined();
  });

  it('expires open suggestions when the entity is deleted', () => {
    const { mine } = seed();
    const made = proposals.proposeFrom({ title: 'Merge', why: 'Same job', entity: { type: 'initiative', id: mine.id } }, 'analyst')!;
    entities.deleteEntity('initiative', mine.id);
    expect(proposals.getProposal(made.id)?.status).toBe('expired');
  });
});

describe('Find Similar and the walls', () => {
  it('finds entities by their words, with the six-field projection for other projects', async () => {
    seed();
    const scope = scopeForActor(aliceActor);
    const found = await findSimilar('Remind customers about unpaid invoices', { scope, kinds: ['entity'], includeOthers: true });
    const own = found.find((m) => m.title === 'Invoice reminders')!;
    expect(own).toMatchObject({ type: 'entity', yours: true, id: 'initiative/invoice-reminders', entityType: 'initiative', owner: 'Alice', project: 'Alpha' });
    const wall = found.find((m) => m.title === 'Overdue invoice nagger')!;
    expect(Object.keys(wall).sort()).toEqual(['goal', 'owner', 'project', 'score', 'title', 'type']);
    expect(wall).toMatchObject({ type: 'entity', owner: 'Collections team', project: 'Beta', goal: 'Remind customers about unpaid invoices by email.' });
    expect(JSON.stringify(found)).not.toMatch(/overdue-nagger|sk-hidden/);
    expect((await findSimilar('Remind customers about unpaid invoices', { scope, kinds: ['entity'] })).map((m) => m.title)).toEqual(['Invoice reminders']);
    expect(await findSimilar('Remind customers about unpaid invoices', { kinds: ['entity'], exclude: { entity: 'initiative/invoice-reminders' } })).not.toContainEqual(expect.objectContaining({ title: 'Invoice reminders' }));
  });
});

describe('the Entity node', () => {
  it('creates in the workflow’s project, reads, lists, adds a fact and deletes', async () => {
    asker();
    const made = (await runOk(brainEntityNode, { operation: 'upsert', type: 'system', entityId: '', name: 'Billing API', description: 'Takes the payments', owner: 'Platform team', attributes: '{"tier": 1}' })).json()[0] as any;
    expect(made).toMatchObject({ created: true, entity: { type: 'system', name: 'Billing API', projectId: alpha.id, source: 'workflow', attrs: { tier: 1 } } });
    const id = made.entity.id;
    const fact = (await runOk(brainEntityNode, { operation: 'addFact', type: 'system', entityId: id, factKind: 'dependency', statement: 'The invoice job calls it' })).json()[0] as any;
    expect(fact.fact).toMatchObject({ kind: 'dependency', subjectType: 'entity' });
    const got = (await runOk(brainEntityNode, { operation: 'get', type: 'system', entityId: id })).json()[0] as any;
    expect(got.entity.name).toBe('Billing API');
    expect(got.facts).toHaveLength(1);
    const listed = (await runOk(brainEntityNode, { operation: 'list', type: '', owner: 'Platform team', text: 'billing', limit: 10, oneItem: false })).json();
    expect(listed.map((e) => e.id)).toEqual([id]);
    expect((await runOk(brainEntityNode, { operation: 'list', type: 'person', owner: '', text: '', limit: 10, oneItem: true })).json()).toEqual([{ entities: [] }]);
    expect(((await runOk(brainEntityNode, { operation: 'delete', type: 'system', entityId: id })).json()[0] as any).deleted).toBe(true);
    await expect(runOk(brainEntityNode, { operation: 'get', type: 'system', entityId: id })).rejects.toThrow(/No system/);
  });

  it('does not see or change entities of projects its creator cannot open', async () => {
    asker();
    seed();
    const ids = (await runOk(brainEntityNode, { operation: 'list', type: '', owner: '', text: '', limit: 10, oneItem: false })).json().map((e) => e.id);
    expect(ids).toEqual(['invoice-reminders']);
    for (const operation of ['get', 'delete', 'upsert', 'addFact']) {
      await expect(runOk(brainEntityNode, { operation, type: 'initiative', entityId: 'overdue-nagger', name: 'x', statement: 'x', factKind: 'purpose' })).rejects.toThrow(/No initiative overdue-nagger/);
    }
    await expect(runOk(brainEntityNode, { operation: 'get', type: '', entityId: 'x' })).rejects.toThrow(/Choose a type/);
  });

  it('is a tool the Platform analyst has, without a way to delete', () => {
    const tools = (analystConfig().tools ?? []).filter((t) => t.type === 'node' && t.nodeType === 'core.brainEntity') as Array<{ parameters: Record<string, unknown> }>;
    expect(tools.map((t) => t.parameters.operation)).toEqual(['list', 'addFact']);
  });
});

describe('Landflow Usage and Suggest Improvement nodes', () => {
  it('searches facts about entities only, and returns Entity Knowledge', async () => {
    asker();
    const { mine } = seed();
    entities.addEntityFact(mine, { kind: 'quality', statement: 'Reminder emails were opened less' });
    facts.upsertFact({ subjectType: 'workflow', subjectId: 'wf_x', subjectName: 'Mailer', kind: 'usage', statement: 'Sends reminder emails', evidence: [], confidence: 1, projectId: alpha.id });
    store.saveWorkflow({ id: 'wf_x', name: 'Mailer', active: false, nodes: [], connections: [], createdBy: alice.id } as Workflow);
    setHomeProject('workflow', 'wf_x', alpha.id);
    const only = (await runOk(landflowUsageNode, { operation: 'facts', query: 'reminder emails', subjectType: 'entity', limit: 10, oneItem: false })).json();
    expect(only.map((f) => f.subjectType)).toEqual(['entity']);
    const all = (await runOk(landflowUsageNode, { operation: 'facts', query: 'reminder emails', subjectType: '', limit: 10, oneItem: false })).json();
    expect(all.map((f) => f.subjectType).sort()).toEqual(['entity', 'workflow']);

    proposals.proposeFrom({ title: 'Retry reminders', why: 'bounces', entity: { type: 'initiative', id: mine.id } }, 'analyst');
    const knowledge = (await runOk(landflowUsageNode, { operation: 'entity', entityType: 'initiative', entityId: 'invoice-reminders' })).json()[0] as any;
    expect(knowledge.entity.name).toBe('Invoice reminders');
    expect(knowledge.facts.map((f: any) => f.kind)).toEqual(['quality']);
    expect(knowledge.proposals.map((p: any) => p.title)).toEqual(['Retry reminders']);
    expect(((await runOk(landflowUsageNode, { operation: 'entity', entityType: 'person', entityId: 'initiative/invoice-reminders' })).json()[0] as any).entity.id).toBe('invoice-reminders');
    await expect(runOk(landflowUsageNode, { operation: 'entity', entityType: 'initiative', entityId: 'overdue-nagger' })).rejects.toThrow(/No initiative/);
  });

  it('Suggest Improvement can be About Entity, inside the creator’s projects', async () => {
    asker();
    seed();
    const saved = (await runOk(suggestImprovementNode, { title: 'Merge these', why: 'same job', entityType: 'initiative', entityId: 'invoice-reminders', ops: '[]', risk: 'low', confidence: 0.7 })).json()[0] as any;
    expect(saved.saved).toBe(true);
    expect(saved.proposal.target).toMatchObject({ type: 'entity', id: 'initiative/invoice-reminders', name: 'Invoice reminders' });
    await expect(runOk(suggestImprovementNode, { title: 'x', why: 'y', entityType: 'initiative', entityId: 'overdue-nagger', ops: '[]' })).rejects.toThrow(/can’t suggest/);
    await expect(runOk(suggestImprovementNode, { title: 'x', why: 'y', entityType: 'initiative', entityId: '', ops: '[]' })).rejects.toThrow(/type and an ID/);
  });
});

describe('over the instance MCP server', () => {
  async function connect(actor?: { id: string; role: 'member' | 'owner' }) {
    const { Client, InMemoryTransport } = await import('@modelcontextprotocol/client');
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await instanceServer(actor).connect(serverSide);
    const client = new Client({ name: 'entities-test', version: '1.0.0' });
    await client.connect(clientSide);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const result = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: Array<{ text: string }> };
      return { error: Boolean(result.isError), text: result.content[0].text, data: result.isError ? undefined : (JSON.parse(result.content[0].text) as Record<string, any>) };
    };
    return { client, call };
  }

  it('check_overlap and brain_search_facts include entities; brain_suggest can be about one', async () => {
    const { mine } = seed();
    entities.addEntityFact(mine, { kind: 'quality', statement: 'Reminder emails were opened less' });
    const { client, call } = await connect(aliceActor);
    const overlap = await call('check_overlap', { text: 'Remind customers about unpaid invoices', what: ['entity'] });
    expect(overlap.data!.matches.map((m: any) => `${m.title}:${m.yours ?? false}`).sort()).toEqual(['Invoice reminders:true', 'Overdue invoice nagger:false']);
    expect(overlap.text).not.toMatch(/overdue-nagger|sk-hidden/);
    const searched = await call('brain_search_facts', { query: 'reminder emails', subjectType: 'entity' });
    expect(searched.data!.facts.map((f: any) => f.subjectName)).toEqual(['Invoice reminders']);
    const suggested = await call('brain_suggest', { title: 'Merge these', why: 'same job', entity: { type: 'initiative', id: 'invoice-reminders' } });
    expect(suggested.data).toMatchObject({ saved: true, proposal: { target: { type: 'entity', id: 'initiative/invoice-reminders' } } });
    const refused = await call('brain_suggest', { title: 'Merge these', why: 'same job', entity: { type: 'initiative', id: 'overdue-nagger' } });
    expect(refused.error).toBe(true);
    await client.close();
  });
});

describe('the routes', () => {
  it('add, list, read, change, note a fact on and delete an entity', async () => {
    const created = await call(entitiesRoute.POST, '/api/entities', { json: { type: 'initiative', id: 'onboarding', name: 'Onboarding revamp', description: 'Cut time to first value', owner: 'Growth', attrs: { quarter: 'Q3' } } });
    expect(created.status).toBe(201);
    expect(created.body.entity).toMatchObject({ type: 'initiative', id: 'onboarding', owner: 'Growth', attrs: { quarter: 'Q3' } });
    const updated = await call(entitiesRoute.POST, '/api/entities', { json: { type: 'initiative', id: 'onboarding', owner: 'Product' } });
    expect(updated.status).toBe(200);
    expect(updated.body.entity).toMatchObject({ name: 'Onboarding revamp', owner: 'Product' });
    expect((await call(entitiesRoute.POST, '/api/entities', { json: { type: 'person' } })).status).toBe(400);
    expect((await call(entitiesRoute.POST, '/api/entities', { json: { type: 'team', name: 'x' } })).status).toBe(400);

    expect((await call(entitiesRoute.GET, '/api/entities?type=initiative&q=revamp')).body.entities).toHaveLength(1);
    expect((await call(entitiesRoute.GET, '/api/entities?type=bogus')).status).toBe(400);

    const patched = await call(entityRoute.PATCH, '/api/entities/initiative/onboarding', { method: 'PATCH', json: { description: '', attrs: { quarter: null, size: 3 } } }, { type: 'initiative', id: 'onboarding' });
    expect(patched.body.entity.attrs).toEqual({ size: 3 });
    expect(patched.body.entity).not.toHaveProperty('description');

    const fact = await call(entityFactsRoute.POST, '/api/entities/initiative/onboarding/facts', { json: { kind: 'health', statement: 'Slipping a sprint' } }, { type: 'initiative', id: 'onboarding' });
    expect(fact.status).toBe(201);
    expect((await call(entityFactsRoute.POST, '/x', { json: { kind: 'nope', statement: 'x' } }, { type: 'initiative', id: 'onboarding' })).status).toBe(400);

    const listedFacts = await call(factsRoute.GET, '/api/brain/facts?subjectType=entity&subjectId=initiative/onboarding');
    expect(listedFacts.body.facts).toHaveLength(1);

    const prop = await call(proposalsRoute.POST, '/api/proposals', { json: { title: 'Fold into activation', why: 'overlap', entity: { type: 'initiative', id: 'onboarding' } } });
    expect(prop.status).toBe(201);
    expect(prop.body.proposal.target).toMatchObject({ type: 'entity', id: 'initiative/onboarding', name: 'Onboarding revamp' });
    expect((await call(proposalsRoute.POST, '/api/proposals', { json: { title: 'x', why: 'y', entity: { type: 'initiative', id: 'missing' } } })).status).toBe(404);
    const dismissed = await call(proposalRoute.PATCH, `/api/proposals/${prop.body.proposal.id}`, { method: 'PATCH', json: { action: 'dismiss', reason: 'intended' } }, { id: prop.body.proposal.id });
    expect(dismissed.status).toBe(200);

    const got = await call(entityRoute.GET, '/api/entities/initiative/onboarding', {}, { type: 'initiative', id: 'onboarding' });
    expect(got.body.facts.map((f: any) => f.kind).sort()).toEqual(['health', 'intended']);
    expect(got.body.proposals).toEqual([]);

    expect((await call(entityRoute.DELETE, '/api/entities/initiative/onboarding', { method: 'DELETE' }, { type: 'initiative', id: 'onboarding' })).body).toEqual({ ok: true });
    expect((await call(entityRoute.GET, '/api/entities/initiative/onboarding', {}, { type: 'initiative', id: 'onboarding' })).status).toBe(404);
  });
});
