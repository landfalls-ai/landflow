/**
 * The Landledger templates (plugins/landledger/flows) run end to end: each is used as a template with its credentials
 * picked, then run from its triggers the way production starts them. The Landledger node and trigger are the plugin's
 * own (in-process) against the plugin's in-memory fake Landledger; Slack is a stand-in that records what it was asked;
 * Landflow's agent and usage API is a local fake the HTTP Request nodes call. No network beyond loopback.
 *
 * - Approve an infrastructure change: the form and the pull request webhook raise an infra_change request with the
 *   evidence; a decision for a request this flow raised goes on to the placeholder and a Slack post, a rejection is
 *   posted with the comment, and one for another flow's request is ignored.
 * - Raise or hold an AI budget: AI calls of an agent past 80% of its monthly cap raise one ai_budget request (as the
 *   agent, with its sponsor); on approval the cap is saved and published through Landflow's API and the request marked
 *   applied; a rejection, or an agent with unpublished edits, holds.
 * - Ask the approver in Slack: a pending step sends each approver a card whose buttons carry the evidence hash; a press
 *   (Slack's block_actions payload) is relayed as the presser's decision, by their Slack email; a refusal says why.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin, type IPlugin, type JsonObject, type NodeDescriptor, type NodeItem } from '@landflow/sdk';
import { landledgerApi, LandledgerNode } from '../../../plugins/landledger/src/nodes/landledger';
import { LandledgerTrigger } from '../../../plugins/landledger/src/nodes/landledger-trigger';
import { KEY, startFakeLandledger, type FakeLandledger } from '../../../plugins/landledger/test/fake-landledger';
import { buttonPress } from '../../../plugins/messaging/src/nodes/slack-trigger';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-landledger-flows-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const templates = await import('@/lib/server/templates');
const { runWorkflow } = await import('@/lib/server/runner');

const repo = join(import.meta.dirname, '..', '..', '..');
const flowFile = (name: string) => JSON.parse(readFileSync(join(repo, 'plugins/landledger/flows', name), 'utf8'));
const fixtures = join(import.meta.dirname, 'fixtures/plugin-manifests');
const messaging = JSON.parse(readFileSync(join(fixtures, 'messaging.json'), 'utf8'));
const landledgerManifest = JSON.parse(readFileSync(join(fixtures, 'landledger.json'), 'utf8'));

// ---- Slack: a stand-in that records every call and knows three people.
const SLACK_PEOPLE: Record<string, { email: string; real_name: string }> = {
  U_AMIT: { email: 'amit.gal@landbright.test', real_name: 'Amit Gal' },
  U_EDEN: { email: 'eden.tzur@landbright.test', real_name: 'Eden Tzur' },
  U_NOA: { email: 'noa.levi@landbright.test', real_name: 'Noa Levi' },
};
const slackCalls: Array<{ op: string; parameters: JsonObject }> = [];
const slackNode = defineNode({
  description: messaging.nodes.find((n: NodeDescriptor) => n.name === 'slack') as NodeDescriptor,
  async execute(ctx) {
    return ctx.getInputData().map((_item, i) => {
      const op = `${ctx.getNodeParameter<string>('resource', i)}.${ctx.getNodeParameter<string>('operation', i)}`;
      const parameters: JsonObject = {};
      for (const name of ['email', 'userId', 'channelId', 'text', 'blocksUi', 'ts']) {
        const value = ctx.getNodeParameter(name, i, undefined as never);
        if (value !== undefined && value !== '') parameters[name] = value as JsonObject[string];
      }
      slackCalls.push({ op, parameters });
      if (op === 'user.getByEmail') {
        const id = Object.keys(SLACK_PEOPLE).find((k) => SLACK_PEOPLE[k].email === parameters.email);
        if (!id) throw new Error('users_not_found');
        return { json: { id, name: id.toLowerCase(), ...SLACK_PEOPLE[id] } };
      }
      if (op === 'user.get') return { json: { id: String(parameters.userId), name: String(parameters.userId).toLowerCase(), ...SLACK_PEOPLE[String(parameters.userId)] } };
      if (op === 'message.post') return { json: { ok: true, channel: `D_${parameters.channelId}`, ts: `17000000${slackCalls.length}.000100` } };
      return { json: { ok: true } };
    });
  },
});
registry.registerBuiltin(corePlugin);
// The rest of the messaging plugin is there for its descriptors only (a trigger's output is given to the run).
registry.registerBuiltin({
  info: messaging.plugin,
  nodes: messaging.nodes.map((d: NodeDescriptor) => (d.name === 'slack' ? slackNode : { description: d, execute: async () => [[]] })),
  credentialTypes: messaging.credentialTypes,
} as unknown as IPlugin);
registry.registerBuiltin(
  definePlugin({ info: landledgerManifest.plugin, nodes: [LandledgerNode, LandledgerTrigger], credentialTypes: [landledgerApi], iconDir: new URL('../../../plugins/landledger/icons/', import.meta.url) }) as IPlugin,
);

// ---- Landflow's agent and usage API, as the HTTP Request nodes see it (an lf_ bearer key).
interface FakeAgent extends JsonObject {
  id: string;
  name: string;
  instructions: string;
  settings: JsonObject;
}
const landflowCalls: Array<{ method: string; path: string; query: Record<string, string>; auth: string; body: JsonObject | null }> = [];
const agents = new Map<string, FakeAgent & { published?: JsonObject }>();
const monthCost = new Map<string, number>();
const published = (a: FakeAgent) => ({ version: 1, publishedAt: '2026-11-01T00:00:00.000Z', config: { name: a.name, instructions: a.instructions, settings: structuredClone(a.settings) } });
function seedAgents() {
  agents.clear();
  monthCost.clear();
  const add = (agent: FakeAgent, cost: number, draftEdits = false) => {
    agents.set(agent.id, { ...agent, published: published(agent), ...(draftEdits && { instructions: `${agent.instructions} (edited)` }) });
    monthCost.set(agent.id, cost);
  };
  add({ id: 'ag_hot', name: 'Support agent', instructions: 'Answer tickets', settings: { monthlyCostLimit: 100, dailyCostLimit: 10, maxIterations: 20 } }, 85);
  add({ id: 'ag_cool', name: 'Digest agent', instructions: 'Write digests', settings: { monthlyCostLimit: 100 } }, 10);
  add({ id: 'ag_nocap', name: 'Research agent', instructions: 'Research', settings: {} }, 500);
  add({ id: 'ag_draft', name: 'Billing agent', instructions: 'Answer billing', settings: { monthlyCostLimit: 200 } }, 190, true);
}
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
const landflow = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x');
  const raw = await readBody(req);
  const body = raw ? (JSON.parse(raw) as JsonObject) : null;
  landflowCalls.push({ method: req.method ?? '', path: url.pathname, query: Object.fromEntries(url.searchParams), auth: String(req.headers.authorization ?? ''), body });
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (req.headers.authorization !== 'Bearer lf_test_key') return send(401, { error: 'Unauthorized' });
  const [, , resource, id, sub] = url.pathname.split('/');
  const agent = resource === 'agents' && id ? agents.get(id) : undefined;
  if (req.method === 'GET' && resource === 'usage') {
    const cost = monthCost.get(url.searchParams.get('agentId') ?? '') ?? 0;
    return send(200, { rows: [{ key: url.searchParams.get('agentId'), cost, count: 3 }], totals: { count: 3, cost } });
  }
  if (!agent) return send(404, { error: 'Agent not found' });
  if (req.method === 'GET' && !sub) return send(200, { agent, ownership: 'owner' });
  if (req.method === 'PUT' && !sub) {
    if (body?.settings) agent.settings = body.settings as JsonObject;
    return send(200, { agent });
  }
  if (req.method === 'POST' && sub === 'publish') {
    agent.published = { ...published(agent), version: Number((agent.published as { version?: number } | undefined)?.version ?? 0) + 1 };
    return send(200, { agent });
  }
  send(404, { error: 'Not found' });
});

let fake: FakeLandledger;
let landflowUrl = '';
const slots: Record<string, string> = {};
beforeAll(async () => {
  fake = await startFakeLandledger();
  await new Promise<void>((resolve) => landflow.listen(0, '127.0.0.1', resolve));
  landflowUrl = `http://127.0.0.1:${(landflow.address() as AddressInfo).port}`;
  slots.landledger = credentials.create({ name: 'Landledger (test)', type: 'landledger.landledgerApi', data: { baseUrl: fake.url, apiKey: KEY } }).id;
  slots.slack = credentials.create({ name: 'Slack (test)', type: 'messaging.slackApi', data: { accessToken: 'xoxb-test', signingSecret: 'test-signing-secret' } }).id;
  slots.landflow = credentials.create({ name: 'Landflow (test)', type: 'core.httpBearerAuth', data: { token: 'lf_test_key' } }).id;
  slots.webhook = credentials.create({ name: 'Webhook (test)', type: 'core.httpHeaderAuth', data: { name: 'X-Webhook-Token', value: 'ci-secret' } }).id;
});
afterAll(async () => {
  await fake.close();
  await new Promise((resolve) => landflow.close(resolve));
});
beforeEach(() => {
  fake.reset();
  slackCalls.length = 0;
  landflowCalls.length = 0;
  seedAgents();
});

/** Use a template with every slot it declares picked, pointing its Settings code at the fake Landflow. */
async function install(name: string) {
  const file = flowFile(name);
  const imported = templates.importTemplate(file, 'tester');
  const picked = Object.fromEntries((file.template.credentials as Array<{ id: string }>).map((s) => [s.id, slots[s.id]]));
  const used = await templates.useTemplate(imported.id, { credentials: picked });
  const workflow = store.getWorkflow(used.workflow!.id)!;
  for (const n of workflow.nodes) {
    for (const key of ['code', 'codeEach'] as const) {
      if (typeof n.parameters[key] === 'string') n.parameters[key] = (n.parameters[key] as string).replace("'http://localhost:3000'", `'${landflowUrl}'`);
    }
  }
  store.saveWorkflow(workflow);
  return store.getWorkflow(workflow.id)!;
}
const nodeId = (workflow: { nodes: Array<{ id: string; name: string }> }, name: string) => workflow.nodes.find((n) => n.name === name)!.id;
async function run(workflow: Awaited<ReturnType<typeof install>>, trigger: string, items: JsonObject[]) {
  // As production starts a run from one trigger (an app webhook, a poll, a form): that trigger only.
  const start = nodeId(workflow, trigger);
  const record = await runWorkflow({ workflow, mode: 'webhook', startNodeId: start, triggerOutput: { nodeId: start, items: items.map((json) => ({ json })) } });
  const out = (name: string): NodeItem[] => record.runData[nodeId(workflow, name)]?.at(-1)?.outputs.flat() ?? [];
  const ran = (name: string) => Boolean(record.runData[nodeId(workflow, name)]);
  return { record, out, ran };
}

/** What Landledger's webhook delivers, as the Landledger Trigger turns it into an item. */
function summaryOf(request: JsonObject): JsonObject {
  const { evidence: _e, steps: _s, decisions: _d, reservations: _r, related: _rel, ...rest } = request;
  return { ...rest, stepLabel: String(request.status), stepCount: 1, budgetLeftAfter: null };
}
function decided(requestId: string, outcome: 'approved' | 'rejected'): JsonObject {
  const request = fake.state.requests.get(requestId) as JsonObject;
  const decisions = request.decisions as JsonObject[];
  return {
    type: 'request.decided',
    id: `evt_${requestId}_${outcome}`,
    timestamp: '2026-11-14T15:06:00.000Z',
    request: summaryOf(request),
    outcome,
    decision: decisions.at(-1) ?? null,
    reservations: [],
    requestId,
    kind: String(request.kind),
    costCenter: (request.costCenter as JsonObject).code,
  };
}
async function decide(requestId: string, outcome: 'approve' | 'reject', comment = '') {
  const detail = (await (await fetch(`${fake.url}/api/requests/${requestId}`, { headers: { authorization: `Bearer ${KEY}` } })).json()) as JsonObject;
  const response = await fetch(`${fake.url}/api/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ person: { email: 'amit.gal@landbright.test' }, outcome, comment, evidenceSha256: detail.evidenceSha256, channel: 'console' }),
  });
  expect(response.status).toBe(201);
}

describe('Landledger: approve an infrastructure change', () => {
  it('a form raises an infra_change request, as the person, with the evidence and the pull request', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    const { record, out } = await run(workflow, 'Infra change form', [
      { title: 'Second Postgres replica', costCenter: 'eng-platform', monthlyAmount: 1840, requester: 'Eden.Tzur@landbright.test', pullRequestUrl: 'https://github.com/landfalls-ai/infra/pull/42', note: 'Read load', submittedAt: '2026-11-14T15:00:00Z', formMode: 'production' },
    ]);
    expect(record.status).toBe('success');
    const created = fake.requests.find((r) => r.method === 'POST' && r.path === '/api/requests')!;
    expect(created.body).toMatchObject({
      kind: 'infra_change',
      title: 'Second Postgres replica',
      costCenter: 'ENG-PLATFORM',
      amount: { amount: '1840', currency: 'USD' },
      recurrence: 'monthly',
      requester: { kind: 'person', person: { email: 'eden.tzur@landbright.test' } },
      note: 'Read load',
      evidence: { lines: [{ label: 'Second Postgres replica', amount: '1840.00' }], basis: 'Sized in the pull request', links: [{ label: 'Pull request', url: 'https://github.com/landfalls-ai/infra/pull/42' }] },
      origin: { type: 'landflow_run', workflowId: workflow.id, title: 'Approve an infrastructure change (form)' },
      related: [{ type: 'pull_request', url: 'https://github.com/landfalls-ai/infra/pull/42' }],
      submit: true,
    });
    expect(out('Ask Landledger')[0].json).toMatchObject({ created: true, request: { status: 'pending', kind: 'infra_change' } });
  });

  it('a pull request webhook raises the same request from its body', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    const { record } = await run(workflow, 'Pull request webhook', [
      { headers: {}, params: {}, query: {}, body: { title: 'Bigger node pool', costCenter: 'ENG-PLATFORM', monthlyAmount: '320.5', requester: 'eden.tzur@landbright.test', pullRequestUrl: 'https://github.com/landfalls-ai/infra/pull/43', basis: 'infracost diff' } },
    ]);
    expect(record.status).toBe('success');
    expect(fake.requests.at(-1)!.body).toMatchObject({
      title: 'Bigger node pool',
      amount: { amount: '320.5' },
      evidence: { basis: 'infracost diff' },
      origin: { title: 'Approve an infrastructure change (pull request)' },
    });
  });

  it('an approval of its own request goes on to the placeholder and a Slack post; a rejection posts the comment; another flow’s request is ignored', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    await run(workflow, 'Infra change form', [{ title: 'Second Postgres replica', costCenter: 'ENG-PLATFORM', monthlyAmount: 1840, requester: 'eden.tzur@landbright.test' }]);
    await run(workflow, 'Infra change form', [{ title: 'Third replica', costCenter: 'ENG-PLATFORM', monthlyAmount: 1840, requester: 'eden.tzur@landbright.test' }]);
    const [first, second] = [...fake.state.requests.keys()];
    await decide(first, 'approve');
    await decide(second, 'reject', 'Not this quarter');

    const approved = await run(workflow, 'Request decided', [decided(first, 'approved')]);
    expect(approved.record.status).toBe('success');
    expect(approved.out('Get the request')[0].json).toMatchObject({ request: { id: first, status: 'approved' } });
    expect(approved.ran('Apply the change')).toBe(true);
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0]).toMatchObject({ op: 'message.post', parameters: { channelId: '#infra-changes' } });
    expect(String(slackCalls[0].parameters.text)).toMatch(/approved:\* Second Postgres replica \(ENG-PLATFORM, 1840\.00 USD a month\)/);
    expect(String(slackCalls[0].parameters.text)).toContain('Amit Gal');

    slackCalls.length = 0;
    const rejected = await run(workflow, 'Request decided', [decided(second, 'rejected')]);
    expect(rejected.ran('Get the request')).toBe(false);
    expect(slackCalls).toHaveLength(1);
    expect(String(slackCalls[0].parameters.text)).toMatch(/rejected:\* Third replica \(ENG-PLATFORM\)\nAmit Gal: Not this quarter/);

    slackCalls.length = 0;
    const other = decided(first, 'approved');
    (other.request as JsonObject).origin = { type: 'landflow_run', workflowId: 'wf_someone_else', executionId: 'ex_1' };
    const ignored = await run(workflow, 'Request decided', [other]);
    expect(ignored.out('Raised by this flow')).toEqual([]);
    expect(ignored.ran('Approved?')).toBe(false);
    expect(slackCalls).toHaveLength(0);
  });
});

describe('Landledger: raise or hold an AI budget', () => {
  const calls = (n = 1) => Array.from({ length: n }, (_, i) => ({ kind: 'ai.call', at: '2026-11-14T15:00:00.000Z', agentId: 'ag_hot', cost: 0.5 + i, tokens: 1200 }));

  it('an agent past 80% of its cap asks, as itself with its sponsor, once per month and cap; the others don’t', async () => {
    const workflow = await install('landledger-ai-budget.json');
    const events = [...calls(2), { kind: 'ai.call', agentId: 'ag_cool', cost: 0.1 }, { kind: 'ai.call', agentId: 'ag_nocap', cost: 2 }, { kind: 'ai.call', cost: 0.3 }];
    const { record, out } = await run(workflow, 'Agent AI calls', events);
    expect(record.status).toBe('success');
    // One read of each agent that spent, with the Landflow key; the month's AI cost of each, from the month's start.
    expect(landflowCalls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/agents/')).map((c) => c.path)).toEqual(['/api/agents/ag_hot', '/api/agents/ag_cool', '/api/agents/ag_nocap']);
    const usage = landflowCalls.filter((c) => c.path === '/api/usage');
    expect(usage[0].query).toMatchObject({ groupBy: 'agent', kinds: 'ai.call', agentId: 'ag_hot' });
    expect(usage[0].query.from).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    expect(landflowCalls.every((c) => c.auth === 'Bearer lf_test_key')).toBe(true);

    const over = out('Over the threshold');
    expect(over.map((i) => i.json.agentId)).toEqual(['ag_hot']);
    const plan = over[0].json as JsonObject;
    expect(plan).toMatchObject({ cap: 100, spent: 85, share: 85 });
    expect(Number(plan.newCap)).toBeGreaterThanOrEqual(150);

    const posts = fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/requests');
    expect(posts).toHaveLength(1);
    const month = new Date().toISOString().slice(0, 7);
    expect(posts[0].body).toMatchObject({
      kind: 'ai_budget',
      title: `Raise Support agent's monthly AI cap to $${plan.newCap}`,
      costCenter: 'ENG-AGENTS',
      amount: { amount: String(Number(plan.newCap) - 100) },
      requester: { kind: 'agent', agent: { id: 'ag_hot', name: 'Support agent', system: 'landflow' }, sponsor: { email: 'eden.tzur@landbright.test' } },
      evidence: { agentId: 'ag_hot', cap: 100, spent: 85, newMonthlyCap: plan.newCap, match: { agent: 'ag_hot' } },
      idempotencyKey: `ai-budget:ag_hot:${month}:100`,
    });

    // Later calls in the month return the same request.
    await run(workflow, 'Agent AI calls', calls(1));
    expect(fake.state.requests.size).toBe(1);
  });

  it('on approval, saves and publishes the raised cap through Landflow’s API and marks the request applied', async () => {
    const workflow = await install('landledger-ai-budget.json');
    await run(workflow, 'Agent AI calls', calls(1));
    const [requestId] = [...fake.state.requests.keys()];
    const newCap = (fake.state.requests.get(requestId).evidence as JsonObject).newMonthlyCap;
    await decide(requestId, 'approve');
    landflowCalls.length = 0;

    const { record, out } = await run(workflow, 'Request decided', [decided(requestId, 'approved')]);
    expect(record.status).toBe('success');
    expect(out('Plan the raise')[0].json).toMatchObject({ ok: true, agentId: 'ag_hot', oldCap: 100, newCap, publish: true });
    expect(landflowCalls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/agents/ag_hot', 'PUT /api/agents/ag_hot', 'POST /api/agents/ag_hot/publish']);
    // Only the monthly cap changes; the other settings stay.
    expect(landflowCalls[1].body).toEqual({ settings: { monthlyCostLimit: newCap, dailyCostLimit: 10, maxIterations: 20 } });
    expect(landflowCalls[2].body).toEqual({ skipEval: true });
    expect((agents.get('ag_hot')!.published as { config: { settings: JsonObject } }).config.settings.monthlyCostLimit).toBe(newCap);
    const request = fake.state.requests.get(requestId);
    expect(request.status).toBe('applied');
    expect(request.appliedNote).toBe(`Support agent's monthly AI cap raised from $100 to $${newCap} in Landflow.`);
  });

  it('a rejection holds the cap; an agent with unpublished edits is held for a person', async () => {
    const workflow = await install('landledger-ai-budget.json');
    await run(workflow, 'Agent AI calls', [...calls(1), { kind: 'ai.call', agentId: 'ag_draft', cost: 1 }]);
    const ids = [...fake.state.requests.keys()];
    expect(ids).toHaveLength(2);
    const [hot, draft] = ids;
    await decide(hot, 'reject', 'Not this month');
    await decide(draft, 'approve');
    landflowCalls.length = 0;

    const rejected = await run(workflow, 'Request decided', [decided(hot, 'rejected')]);
    expect(rejected.ran('Hold the cap')).toBe(true);
    expect(rejected.ran('Get the request')).toBe(false);
    expect(landflowCalls).toHaveLength(0);

    const held = await run(workflow, 'Request decided', [decided(draft, 'approved')]);
    expect(held.out('Plan the raise')[0].json).toMatchObject({ ok: false, why: 'Billing agent has unpublished changes: raise the cap by hand, then mark the request applied' });
    expect(held.ran('Hold: raise by hand')).toBe(true);
    expect(landflowCalls.map((c) => c.method)).toEqual(['GET']);
    expect(fake.state.requests.get(draft).status).toBe('approved');
  });
});

describe('Landledger: ask the approver in Slack', () => {
  /** A pending infra_change request raised by Eden, with Amit (in Slack) and someone without an email as approvers. */
  async function pending() {
    const response = await fetch(`${fake.url}/api/requests`, {
      method: 'POST',
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        kind: 'infra_change',
        title: 'Second Postgres replica',
        costCenter: 'ENG-PLATFORM',
        amount: { amount: '1840.00', currency: 'USD' },
        recurrence: 'monthly',
        note: 'Read load doubled',
        evidence: { lines: [{ label: 'db.r6g.large replica', amount: '1840.00' }], basis: 'AWS price list' },
        origin: { type: 'landflow_run', workflowId: 'wf_x', executionId: 'ex_x' },
        related: [{ type: 'pull_request', url: 'https://github.com/landfalls-ai/infra/pull/42' }],
        requester: { kind: 'person', person: { email: 'eden.tzur@landbright.test' } },
      }),
    });
    const { request } = (await response.json()) as { request: JsonObject };
    const detail = (await (await fetch(`${fake.url}/api/requests/${request.id}`, { headers: { authorization: `Bearer ${KEY}` } })).json()) as JsonObject;
    const event: JsonObject = {
      type: 'request.step_pending',
      id: 'evt_pending',
      timestamp: '2026-11-14T15:03:00.000Z',
      request: summaryOf(request),
      step: { position: 1, key: 'owner', label: 'Budget owner', groups: ['Budget Owners'], deadlineAt: '2026-11-16T15:03:00.000Z', escalated: false },
      approvers: [
        { name: 'Amit Gal', email: 'amit.gal@landbright.test', sub: 'sub-amit', via: 'group', group: 'Budget Owners' },
        { name: 'Someone', email: null, sub: 'sub-x', via: 'group', group: 'Budget Owners' },
      ],
      url: `http://localhost:4811/requests/${request.id}`,
      evidenceSha256: detail.evidenceSha256,
      requestId: request.id,
      kind: 'infra_change',
      costCenter: 'ENG-PLATFORM',
    };
    return { requestId: String(request.id), event, sha: String(detail.evidenceSha256) };
  }

  /** Slack's block_actions payload for a press on a card, as the Slack Trigger turns it into an item. */
  const press = (user: string, actionId: string, value: string) =>
    buttonPress({
      type: 'block_actions',
      team: { id: 'T1' },
      api_app_id: 'A1',
      user: { id: user, username: user.toLowerCase(), name: user.toLowerCase() },
      container: { type: 'message', channel_id: `D_${user}`, message_ts: '1700000002.000100' },
      trigger_id: `trig_${user}_${actionId}`,
      response_url: 'https://hooks.slack.com/actions/T1/1/x',
      actions: [{ type: 'button', action_id: actionId, block_id: 'landledger_decision', value, action_ts: '1700000003.0' }],
    });

  it('sends each approver with an email a card with the evidence and the buttons; a press of Approve is relayed as theirs', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, event, sha } = await pending();
    const sent = await run(workflow, 'Step waits on approvers', [event]);
    expect(sent.record.status).toBe('success');
    expect(slackCalls.map((c) => c.op)).toEqual(['user.getByEmail', 'message.post']);
    const card = slackCalls[1].parameters;
    expect(card.channelId).toBe('U_AMIT');
    expect(card.text).toBe(`${fake.state.requests.get(requestId).number}: Second Postgres replica — $1,840 a month for ENG-PLATFORM`);
    const blocks = card.blocksUi as JsonObject[];
    const text = JSON.stringify(blocks);
    expect(text).toContain('Read load doubled');
    expect(text).toContain('db.r6g.large replica: $1,840');
    expect(text).toContain('<https://github.com/landfalls-ai/infra/pull/42|Pull request>');
    const actions = blocks.find((b) => b.type === 'actions')!.elements as JsonObject[];
    expect(actions.map((a) => a.action_id)).toEqual(['landledger_approve', 'landledger_reject', 'landledger_open']);
    const value = String(actions[0].value);
    expect(JSON.parse(value)).toEqual({ r: requestId, n: fake.state.requests.get(requestId).number, s: 1, h: sha });

    slackCalls.length = 0;
    const pressed = await run(workflow, 'Button pressed', [press('U_AMIT', 'landledger_approve', value)]);
    expect(pressed.record.status).toBe('success');
    const relay = fake.requests.find((r) => r.method === 'POST' && r.path === `/api/requests/${requestId}/decisions`)!;
    expect(relay.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(relay.body).toEqual({ person: { email: 'amit.gal@landbright.test' }, outcome: 'approve', comment: '', evidenceSha256: sha, step: 1, channel: 'slack' });
    expect(fake.state.requests.get(requestId)).toMatchObject({ status: 'approved', decisions: [{ person: { email: 'amit.gal@landbright.test' }, via: 'relay', channel: 'slack' }] });
    expect(slackCalls.map((c) => c.op)).toEqual(['user.get', 'message.update']);
    expect(slackCalls[1].parameters).toMatchObject({ channelId: 'D_U_AMIT', ts: '1700000002.000100' });
    expect(String(slackCalls[1].parameters.text)).toMatch(/^✅ R-\d+ approved by Amit Gal · Second Postgres replica$/);
    expect(slackCalls[1].parameters.blocksUi).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: slackCalls[1].parameters.text } }]);
  });

  it('a Reject carries a comment; a press by the requester is refused and the card says why; other buttons start nothing', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, sha } = await pending();
    const value = JSON.stringify({ r: requestId, n: 'R-1', s: 1, h: sha });

    const refused = await run(workflow, 'Button pressed', [press('U_EDEN', 'landledger_approve', value)]);
    expect(refused.record.status).toBe('success');
    expect(fake.state.requests.get(requestId).status).toBe('pending');
    expect(String(slackCalls.at(-1)!.parameters.text)).toMatch(/^⚠️ R-1: Landledger did not take your answer: .*can't decide their own request/);

    slackCalls.length = 0;
    const other = await run(workflow, 'Button pressed', [press('U_AMIT', 'landledger_open', value)]);
    expect(other.out('Approve or Reject')).toEqual([]);
    expect(slackCalls).toHaveLength(0);

    await run(workflow, 'Button pressed', [press('U_AMIT', 'landledger_reject', value)]);
    const relay = fake.requests.filter((r) => r.path === `/api/requests/${requestId}/decisions`).at(-1)!;
    expect(relay.body).toMatchObject({ outcome: 'reject', comment: 'Rejected in Slack by Amit Gal', person: { email: 'amit.gal@landbright.test' } });
    expect(fake.state.requests.get(requestId).status).toBe('rejected');
    expect(String(slackCalls.at(-1)!.parameters.text)).toMatch(/^❌ R-\d+ rejected by Amit Gal/);
  });
});
