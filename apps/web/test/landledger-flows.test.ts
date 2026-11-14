/**
 * The Landledger templates (plugins/landledger/flows) run end to end: each is used as a template with its credentials
 * picked (a requests key, a webhooks key, a relay key), then run from its triggers the way production starts them. The
 * Landledger node and trigger are the plugin's own (in-process) against the plugin's in-memory fake of Landledger's
 * reviewed wave 2 contract; Slack is a stand-in that records what it was asked; Landflow's agent and usage API is a
 * local fake the HTTP Request nodes call. No network beyond loopback.
 *
 * - Approve an infrastructure change: the form and the pull request webhook raise an infra_change request naming the
 *   person, who confirms it (the flow posts the link); a decision is acted on only for a request this flow's key raised
 *   from a run of this workflow, approved now: a forged origin, another key's request or one never raised here is refused.
 * - Raise or hold an AI budget: AI calls of an agent past 80% of its monthly cap raise one ai_budget request per month
 *   (as the agent, with its sponsor); on approval of this flow's own, verified request the cap rises by the approved
 *   amount (never the evidence's figure), once per agent and month; a failed publish is undone and retried hourly.
 * - Ask the approver in Slack: a pending step sends each approver a recorded card with the evidence hash and, on the
 *   budget owner's step, Approve; a press on a recorded card by a workspace member is relayed raw; Landledger decides
 *   who it is. Unknown cards, guests and other teams are not relayed; an outage keeps the buttons; a stale card is rebuilt.
 */
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineNode, definePlugin, type IPlugin, type JsonObject, type NodeDescriptor, type NodeItem } from '@landflow/sdk';
import { landledgerApi, LandledgerNode, landledgerRelayApi } from '../../../plugins/landledger/src/nodes/landledger';
import { LandledgerTrigger } from '../../../plugins/landledger/src/nodes/landledger-trigger';
import { KEY, OTHER_KEY, RELAY_KEY, SLACK_CHANNEL, startFakeLandledger, WEBHOOKS_KEY, type FakeLandledger } from '../../../plugins/landledger/test/fake-landledger';
import { buttonPress } from '../../../plugins/messaging/src/nodes/slack-trigger';
import { slackSignature } from '@landflow/sdk';

vi.setConfig({ testTimeout: 30_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-landledger-flows-'));
Object.assign(process.env, { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const templates = await import('@/lib/server/templates');
const { runWorkflow } = await import('@/lib/server/runner');
const { dataTables } = await import('@/lib/server/datatables/service');

const repo = join(import.meta.dirname, '..', '..', '..');
const flowFile = (name: string) => JSON.parse(readFileSync(join(repo, 'plugins/landledger/flows', name), 'utf8'));
const fixtures = join(import.meta.dirname, 'fixtures/plugin-manifests');
const messaging = JSON.parse(readFileSync(join(fixtures, 'messaging.json'), 'utf8'));
const landledgerManifest = JSON.parse(readFileSync(join(fixtures, 'landledger.json'), 'utf8'));

// ---- Slack: a stand-in that records every call and knows its people (a guest, someone from another organization).
const SLACK_PEOPLE: Record<string, JsonObject> = {
  U_AMIT: { email: 'amit.gal@landbright.test', real_name: 'Amit Gal', team_id: 'T_LANDDEV' },
  U_EDEN: { email: 'eden.tzur@landbright.test', real_name: 'Eden Tzur', team_id: 'T_LANDDEV' },
  U_SHIRA: { email: 'shira.navon@landbright.test', real_name: 'Shira Navon', team_id: 'T_LANDDEV' },
  U_TAL: { email: 'tal.levi@landbright.test', real_name: 'Tal Levi', team_id: 'T_LANDDEV' },
  U_GUEST: { email: 'gus@partner.test', real_name: 'Gus Guest', team_id: 'T_LANDDEV', is_restricted: true, is_guest: true },
  U_EXT: { email: 'amit.gal@landbright.test', real_name: 'Amit Elsewhere', team_id: 'T_OTHER', is_stranger: true },
};
const slackCalls: Array<{ op: string; parameters: JsonObject }> = [];
let slackTs = 0;
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
      const flags = (id: string) => ({ is_bot: false, deleted: false, is_restricted: false, is_ultra_restricted: false, is_guest: false, is_stranger: false, is_app_user: false, ...SLACK_PEOPLE[id] });
      if (op === 'user.getByEmail') {
        const id = Object.keys(SLACK_PEOPLE).find((k) => SLACK_PEOPLE[k].email === parameters.email && SLACK_PEOPLE[k].team_id === 'T_LANDDEV');
        if (!id) throw new Error('users_not_found');
        return { json: { id, name: id.toLowerCase(), ...flags(id) } };
      }
      if (op === 'user.get') return { json: { id: String(parameters.userId), name: String(parameters.userId).toLowerCase(), ...flags(String(parameters.userId)) } };
      if (op === 'message.post') return { json: { ok: true, channel: `D_${parameters.channelId}`, ts: `1700000000.${String(++slackTs).padStart(6, '0')}` } };
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
  definePlugin({ info: landledgerManifest.plugin, nodes: [LandledgerNode, LandledgerTrigger], credentialTypes: [landledgerApi, landledgerRelayApi], iconDir: new URL('../../../plugins/landledger/icons/', import.meta.url) }) as IPlugin,
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
/** How many of the next publishes answer 500. */
let failPublishes = 0;
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
    if (failPublishes > 0) {
      failPublishes--;
      return send(500, { error: 'The evaluation store is down' });
    }
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
  slots.landledger = credentials.create({ name: 'Landledger requests (test)', type: 'landledger.landledgerApi', data: { baseUrl: fake.url, apiKey: KEY } }).id;
  slots.landledgerWebhooks = credentials.create({ name: 'Landledger webhooks (test)', type: 'landledger.landledgerApi', data: { baseUrl: fake.url, apiKey: WEBHOOKS_KEY } }).id;
  slots.landledgerRelay = credentials.create({ name: 'Landledger relay (test)', type: 'landledger.landledgerRelayApi', data: { baseUrl: fake.url, apiKey: RELAY_KEY } }).id;
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
  failPublishes = 0;
  seedAgents();
  // Each template's tables start empty.
  for (const name of ['Landledger infra requests', 'Landledger AI cap raises', 'Landledger Slack cards']) {
    const table = dataTables().findTable(name);
    if (table) dataTables().deleteRows(table.id, { type: 'and', conditions: [{ column: 'id', operator: 'isNotEmpty', value: '' }] });
  }
});
const rowsOf = (name: string) => {
  const table = dataTables().findTable(name);
  return table ? (dataTables().listRows(table.id, {}).rows as JsonObject[]) : [];
};

/** Use a template with every slot it declares picked, pointing its Settings code at the fake Landflow. */
async function install(name: string) {
  const file = flowFile(name);
  const imported = templates.importTemplate(file, 'tester');
  const picked = Object.fromEntries((file.template.credentials as Array<{ id: string }>).map((s) => [s.id, slots[s.id]]));
  const used = await templates.useTemplate(imported.id, { credentials: picked });
  const workflow = store.getWorkflow(used.workflow!.id)!;
  for (const n of workflow.nodes) {
    for (const key of ['code', 'codeEach'] as const) {
      if (typeof n.parameters[key] === 'string') {
        n.parameters[key] = (n.parameters[key] as string)
          .replace("'http://localhost:3000'", `'${landflowUrl}'`)
          .replace("const SLACK_TEAM_ID = '';", `const SLACK_TEAM_ID = '${SLACK_CHANNEL.teamId}';`)
          .replace("const SLACK_APP_ID = '';", `const SLACK_APP_ID = '${SLACK_CHANNEL.appId}';`);
      }
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
/** As a person in their own Landledger session (the fake's `Person <email>` auth). */
const asPerson = (email: string, path: string, init: RequestInit = {}) =>
  fetch(`${fake.url}${path}`, { ...init, headers: { authorization: `Person ${email}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
/** The person a key named confirms the request, from their own session. */
async function confirm(requestId: string) {
  const email = String(fake.state.requests.get(requestId).requesterEmail);
  expect((await asPerson(email, `/api/requests/${requestId}/confirm`, { method: 'POST', body: '{}' })).status).toBe(200);
}
/** An approver decides in their session: reads the request (Landledger serves the evidence to them), then decides on it. */
async function decide(requestId: string, outcome: 'approve' | 'reject', comment = '', email = 'amit.gal@landbright.test') {
  const detail = (await (await asPerson(email, `/api/requests/${requestId}`)).json()) as JsonObject;
  const response = await asPerson(email, `/api/requests/${requestId}/decisions`, { method: 'POST', body: JSON.stringify({ outcome, comment, evidenceSha256: detail.evidenceSha256 }) });
  expect(response.status).toBe(201);
}
/** A request raised straight through the API with some key (another flow's, or a forger's). */
async function raiseWith(key: string, body: JsonObject): Promise<string> {
  const response = await fetch(`${fake.url}/api/requests`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ recurrence: 'monthly', amount: { amount: '100.00', currency: 'USD' }, note: '', evidence: {}, requester: { kind: 'person', person: { email: 'eden.tzur@landbright.test' } }, ...body }),
  });
  expect(response.status).toBe(201);
  return String(((await response.json()) as { request: JsonObject }).request.id);
}

describe('Landledger: approve an infrastructure change', () => {
  const form = (title: string, extra: JsonObject = {}) => ({ title, costCenter: 'ENG-PLATFORM', monthlyAmount: 1840, requester: 'eden.tzur@landbright.test', ...extra });
  function needsConfirmation(requestId: string): JsonObject {
    const request = fake.state.requests.get(requestId) as JsonObject;
    return {
      type: 'request.needs_confirmation', id: `evt_${requestId}_confirm`, timestamp: '2026-11-14T15:01:00.000Z',
      request: summaryOf(request), person: { id: 'usr_r', name: 'Eden Tzur', email: 'eden.tzur@landbright.test' },
      createdBy: request.createdBy, url: `http://localhost:4811/requests/${requestId}`,
      requestId, kind: 'infra_change', costCenter: 'ENG-PLATFORM',
    };
  }

  it('a form raises an infra_change request naming the person, who must confirm it; the run that raised it is recorded', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    const { record, out } = await run(workflow, 'Infra change form', [
      { ...form('Second Postgres replica', { costCenter: 'eng-platform', requester: 'Eden.Tzur@landbright.test', pullRequestUrl: 'https://github.com/landfalls-ai/infra/pull/42', note: 'Read load' }), submittedAt: '2026-11-14T15:00:00Z', formMode: 'production' },
    ]);
    expect(record.status).toBe('success');
    const created = fake.requests.find((r) => r.method === 'POST' && r.path === '/api/requests')!;
    expect(created.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(created.body).toMatchObject({
      kind: 'infra_change',
      title: 'Second Postgres replica',
      costCenter: 'ENG-PLATFORM',
      amount: { amount: '1840', currency: 'USD' },
      recurrence: 'monthly',
      requester: { kind: 'person', person: { email: 'eden.tzur@landbright.test' } },
      note: 'Read load',
      evidence: { lines: [{ label: 'Second Postgres replica', amount: '1840.00' }], basis: 'Sized in the pull request', links: [{ label: 'Pull request', url: 'https://github.com/landfalls-ai/infra/pull/42' }] },
      origin: { type: 'landflow_run', workflowId: workflow.id, executionId: record.executionId, title: 'Approve an infrastructure change (form)' },
      related: [{ type: 'pull_request', url: 'https://github.com/landfalls-ai/infra/pull/42' }],
      submit: true,
    });
    const request = out('Ask Landledger')[0].json.request as JsonObject;
    expect(request).toMatchObject({ status: 'awaiting_confirmation', createdBy: { kind: 'key', id: 'key_flows' }, confirmation: { status: 'waiting' } });
    expect(rowsOf('Landledger infra requests')).toEqual([expect.objectContaining({ request_id: request.id, execution_id: record.executionId, workflow_id: workflow.id, person: 'eden.tzur@landbright.test' })]);
    // The form names nobody as "your email" any more: the field is a claim the person confirms.
    const fields = (workflow.nodes.find((n) => n.name === 'Infra change form')!.parameters.formFields as { values: Array<{ fieldLabel: string }> }).values.map((f) => f.fieldLabel);
    expect(fields).not.toContain('Your Landbright email');
    expect(fields).toContain('Who asks (their Landbright email; they confirm it in Landledger)');
  });

  it('a pull request webhook raises the same request from its body', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    const { record } = await run(workflow, 'Pull request webhook', [
      { headers: {}, params: {}, query: {}, body: { title: 'Bigger node pool', costCenter: 'ENG-PLATFORM', monthlyAmount: '320.5', requester: 'eden.tzur@landbright.test', pullRequestUrl: 'https://github.com/landfalls-ai/infra/pull/43', basis: 'infracost diff' } },
    ]);
    expect(record.status).toBe('success');
    expect(fake.requests.at(-1)!.body).toMatchObject({ title: 'Bigger node pool', amount: { amount: '320.5' }, evidence: { basis: 'infracost diff' }, origin: { title: 'Approve an infrastructure change (pull request)' } });
  });

  it('posts the confirm link for a request it raised; another flow’s confirmation passes by', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    await run(workflow, 'Infra change form', [form('Second Postgres replica')]);
    const [ours] = [...fake.state.requests.keys()];
    const posted = await run(workflow, 'Landledger events', [needsConfirmation(ours)]);
    expect(posted.record.status).toBe('success');
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0]).toMatchObject({ op: 'message.post', parameters: { channelId: '#infra-changes' } });
    expect(String(slackCalls[0].parameters.text)).toBe(`📝 *R-1* Second Postgres replica waits for Eden Tzur to confirm it in Landledger before the approvers see it: http://localhost:4811/requests/${ours}`);
    slackCalls.length = 0;
    const theirs = await raiseWith(OTHER_KEY, { kind: 'infra_change', title: 'Not ours', costCenter: 'ENG-PLATFORM', origin: { type: 'landflow_run', workflowId: 'wf_other', executionId: 'ex_other' } });
    expect((await run(workflow, 'Landledger events', [needsConfirmation(theirs)])).ran('Post the confirm link')).toBe(false);
    expect(slackCalls).toHaveLength(0);
  });

  it('an approval of its own request goes on to the placeholder and a Slack post; a rejection posts the comment', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    await run(workflow, 'Infra change form', [form('Second Postgres replica')]);
    await run(workflow, 'Infra change form', [form('Third replica')]);
    const [first, second] = [...fake.state.requests.keys()];
    for (const id of [first, second]) await confirm(id);
    await decide(first, 'approve');
    await decide(second, 'reject', 'Not this quarter');

    const approved = await run(workflow, 'Landledger events', [decided(first, 'approved')]);
    expect(approved.record.status).toBe('success');
    expect(approved.out('Ours to act on?')[0].json).toMatchObject({ ours: true, why: '', route: 0, request: { id: first, status: 'approved' } });
    expect(approved.ran('Apply the change')).toBe(true);
    expect(slackCalls).toHaveLength(1);
    expect(slackCalls[0]).toMatchObject({ op: 'message.post', parameters: { channelId: '#infra-changes' } });
    expect(String(slackCalls[0].parameters.text)).toMatch(/approved:\* Second Postgres replica \(ENG-PLATFORM, 1840\.00 USD a month\)/);
    expect(String(slackCalls[0].parameters.text)).toContain('Amit Gal');

    slackCalls.length = 0;
    const rejected = await run(workflow, 'Landledger events', [decided(second, 'rejected')]);
    expect(rejected.ran('Apply the change')).toBe(false);
    expect(slackCalls).toHaveLength(1);
    expect(String(slackCalls[0].parameters.text)).toMatch(/rejected:\* Third replica \(ENG-PLATFORM\)\nAmit Gal: Not this quarter/);
  });

  it('refuses a forged origin: another key’s request naming this workflow and one of its runs', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    const raised = await run(workflow, 'Infra change form', [form('Second Postgres replica')]);
    // A forger copies a real run's origin with a key of their own.
    const forged = await raiseWith(OTHER_KEY, { kind: 'infra_change', title: 'Forged replica', costCenter: 'ENG-PLATFORM', origin: { type: 'landflow_run', workflowId: workflow.id, executionId: raised.record.executionId } });
    await confirm(forged);
    await decide(forged, 'approve');
    const refused = await run(workflow, 'Landledger events', [decided(forged, 'approved')]);
    expect(refused.out('Ours to act on?')[0].json).toMatchObject({ ours: false, route: 2 });
    expect(String(refused.out('Ours to act on?')[0].json.why)).toMatch(/raised by Someone else, not this flow's key \(Landflow flows\)/);
    expect(refused.ran('Not this flow\'s: refused')).toBe(true);
    expect(refused.ran('Apply the change')).toBe(false);
    expect(slackCalls).toHaveLength(0);
  });

  it('refuses a request this flow’s key raised outside this workflow’s runs, and one no longer approved', async () => {
    const workflow = await install('landledger-approve-infra-change.json');
    const outside = await raiseWith(KEY, { kind: 'infra_change', title: 'Raised by hand with the key', costCenter: 'ENG-PLATFORM', origin: { type: 'landflow_run', workflowId: workflow.id, executionId: 'ex_made_up' } });
    await confirm(outside);
    await decide(outside, 'approve');
    const refused = await run(workflow, 'Landledger events', [decided(outside, 'approved')]);
    expect(refused.out('Ours to act on?')[0].json).toMatchObject({ ours: false, why: 'no run of this workflow raised it' });
    expect(refused.ran('Apply the change')).toBe(false);

    await run(workflow, 'Infra change form', [form('Second Postgres replica')]);
    const ours = [...fake.state.requests.keys()].at(-1)!;
    await confirm(ours);
    await decide(ours, 'approve');
    fake.state.requests.get(ours).status = 'cancelled';
    const moved = await run(workflow, 'Landledger events', [decided(ours, 'approved')]);
    expect(moved.out('Ours to act on?')[0].json).toMatchObject({ ours: true, route: 2, why: 'Landledger says it is cancelled now, not approved' });
    expect(moved.ran('Apply the change')).toBe(false);
    expect(slackCalls).toHaveLength(0);
  });
});

describe('Landledger: raise or hold an AI budget', () => {
  const calls = (n = 1) => Array.from({ length: n }, (_, i) => ({ kind: 'ai.call', at: '2026-11-14T15:00:00.000Z', agentId: 'ag_hot', cost: 0.5 + i, tokens: 1200 }));
  const month = () => new Date().toISOString().slice(0, 7);
  /** Ask, have the sponsor confirm and an approver approve: the request id. */
  async function approvedRaise(workflow: Awaited<ReturnType<typeof install>>, agentCalls = calls(1)) {
    await run(workflow, 'Agent AI calls', agentCalls);
    const id = [...fake.state.requests.keys()].at(-1)!;
    await confirm(id);
    await decide(id, 'approve');
    return id;
  }
  const bind = (workflowId: string) => fake.state.bound.set('key_flows', [workflowId]);

  it('an agent past 80% of its cap asks once per month, as itself with its sponsor (who confirms); the others don’t', async () => {
    const workflow = await install('landledger-ai-budget.json');
    const events = [...calls(2), { kind: 'ai.call', agentId: 'ag_cool', cost: 0.1 }, { kind: 'ai.call', agentId: 'ag_nocap', cost: 2 }, { kind: 'ai.call', cost: 0.3 }];
    const { record, out } = await run(workflow, 'Agent AI calls', events);
    expect(record.status).toBe('success');
    expect(landflowCalls.filter((c) => c.method === 'GET' && c.path.startsWith('/api/agents/')).map((c) => c.path)).toEqual(['/api/agents/ag_hot', '/api/agents/ag_cool', '/api/agents/ag_nocap']);
    const usage = landflowCalls.filter((c) => c.path === '/api/usage');
    expect(usage[0].query).toMatchObject({ groupBy: 'agent', kinds: 'ai.call', agentId: 'ag_hot' });
    expect(usage[0].query.from).toMatch(/^\d{4}-\d{2}-01T00:00:00\.000Z$/);
    expect(landflowCalls.every((c) => c.auth === 'Bearer lf_test_key')).toBe(true);

    const over = out('Over the threshold');
    expect(over.map((i) => i.json.agentId)).toEqual(['ag_hot']);
    const plan = over[0].json as JsonObject;
    expect(plan).toMatchObject({ cap: 100, spent: 85, share: 85 });
    const posts = fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/requests');
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toMatchObject({
      kind: 'ai_budget',
      title: `Raise Support agent's monthly AI cap by $${plan.extra}`,
      costCenter: 'ENG-AGENTS',
      amount: { amount: String(Number(plan.extra)) },
      requester: { kind: 'agent', agent: { id: 'ag_hot', name: 'Support agent', system: 'landflow' }, sponsor: { email: 'eden.tzur@landbright.test' } },
      evidence: { agentId: 'ag_hot', cap: 100, spent: 85, match: { agent: 'ag_hot' } },
      idempotencyKey: `ai-budget:ag_hot:${month()}`,
    });
    expect(out('Asked, or already asked')[0].json).toMatchObject({ asked: true, status: 'awaiting_confirmation' });

    // A later batch with newer figures sends the same key with another body: Landledger's 409 means "already asked".
    monthCost.set('ag_hot', 90);
    const again = await run(workflow, 'Agent AI calls', calls(1));
    expect(again.record.status).toBe('success');
    expect(again.out('Asked, or already asked')[0].json).toMatchObject({ asked: false, alreadyAsked: true });
    expect(fake.state.requests.size).toBe(1);
  });

  it('on approval raises the cap in force by the approved amount (never the evidence’s figure), publishes it and marks it applied', async () => {
    const workflow = await install('landledger-ai-budget.json');
    bind(workflow.id);
    const requestId = await approvedRaise(workflow);
    const amount = Number(fake.state.requests.get(requestId).amount.amount);
    // Whatever the evidence says, the raise is the cap in force plus the approved amount.
    (fake.state.requests.get(requestId).evidence as JsonObject).newMonthlyCap = 99999;
    landflowCalls.length = 0;

    const { record, out } = await run(workflow, 'Request decided', [decided(requestId, 'approved')]);
    expect(record.status).toBe('success');
    const newCap = 100 + amount;
    expect(out('Plan the raise')[0].json).toMatchObject({ action: 'raise', agentId: 'ag_hot', oldCap: 100, newCap, publish: true });
    expect(landflowCalls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/agents/ag_hot', 'PUT /api/agents/ag_hot', 'POST /api/agents/ag_hot/publish']);
    expect(landflowCalls[1].body).toEqual({ settings: { monthlyCostLimit: newCap, dailyCostLimit: 10, maxIterations: 20 } });
    expect(landflowCalls[2].body).toEqual({ skipEval: true });
    expect((agents.get('ag_hot')!.published as { config: { settings: JsonObject } }).config.settings.monthlyCostLimit).toBe(newCap);
    const request = fake.state.requests.get(requestId);
    expect(request.status).toBe('applied');
    expect(request.appliedNote).toBe(`Support agent's monthly AI cap raised from $100 to $${newCap} in Landflow.`);
    expect(rowsOf('Landledger AI cap raises')).toEqual([expect.objectContaining({ request_id: requestId, agent_id: 'ag_hot', month: month(), old_cap: 100, new_cap: newCap, status: 'applied', attempts: 1 })]);
  });

  it('holds a request whose origin Landledger did not verify, and one another key raised', async () => {
    const workflow = await install('landledger-ai-budget.json');
    const unverified = await approvedRaise(workflow);
    landflowCalls.length = 0;
    const held = await run(workflow, 'Request decided', [decided(unverified, 'approved')]);
    expect(held.out('Plan the raise')[0].json).toMatchObject({ action: 'hold' });
    expect(String(held.out('Plan the raise')[0].json.why)).toMatch(/origin is not verified as this workflow/);
    expect(held.ran('Hold: raise by hand')).toBe(true);

    bind(workflow.id);
    const forged = await raiseWith(OTHER_KEY, {
      kind: 'ai_budget', title: 'Raise Support agent', costCenter: 'ENG-AGENTS', amount: { amount: '4000.00', currency: 'USD' },
      requester: { kind: 'agent', agent: { id: 'ag_hot', name: 'Support agent', system: 'landflow' }, sponsor: { email: 'eden.tzur@landbright.test' } },
      origin: { type: 'landflow_run', workflowId: workflow.id, executionId: 'ex_x' },
    });
    await confirm(forged);
    await decide(forged, 'approve');
    const refused = await run(workflow, 'Request decided', [decided(forged, 'approved')]);
    expect(String(refused.out('Plan the raise')[0].json.why)).toMatch(/Raised by Someone else, not this flow's key/);
    expect(landflowCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(fake.state.requests.get(forged).status).toBe('approved');
  });

  it('raises an agent’s cap at most once a month: a second approved request is held', async () => {
    const workflow = await install('landledger-ai-budget.json');
    bind(workflow.id);
    const first = await approvedRaise(workflow);
    await run(workflow, 'Request decided', [decided(first, 'approved')]);
    expect(fake.state.requests.get(first).status).toBe('applied');
    const second = await raiseWith(KEY, {
      kind: 'ai_budget', title: 'Raise Support agent again', costCenter: 'ENG-AGENTS', amount: { amount: '30.00', currency: 'USD' },
      requester: { kind: 'agent', agent: { id: 'ag_hot', name: 'Support agent', system: 'landflow' }, sponsor: { email: 'eden.tzur@landbright.test' } },
      origin: { type: 'landflow_run', workflowId: workflow.id, executionId: 'ex_y' },
    });
    await confirm(second);
    await decide(second, 'approve');
    landflowCalls.length = 0;
    const held = await run(workflow, 'Request decided', [decided(second, 'approved')]);
    expect(String(held.out('Plan the raise')[0].json.why)).toBe(`Support agent's cap was already raised this month (${first}): one automatic raise per agent per month`);
    expect(landflowCalls.map((c) => c.method)).toEqual(['GET']);
    expect(fake.state.requests.get(second).status).toBe('approved');
  });

  it('a failed publish puts the cap back and is retried by the hourly reconcile, which also finishes a raise already in place', async () => {
    const workflow = await install('landledger-ai-budget.json');
    bind(workflow.id);
    const requestId = await approvedRaise(workflow);
    const newCap = 100 + Number(fake.state.requests.get(requestId).amount.amount);
    failPublishes = 1;
    const failed = await run(workflow, 'Request decided', [decided(requestId, 'approved')]);
    expect(failed.record.status).toBe('success');
    expect(failed.ran('Report: publish failed')).toBe(true);
    // Nothing half done is left: the draft is back at the published cap, so later raises aren't held as unpublished edits.
    expect(agents.get('ag_hot')!.settings.monthlyCostLimit).toBe(100);
    expect(rowsOf('Landledger AI cap raises')[0]).toMatchObject({ request_id: requestId, status: 'publish_failed', attempts: 1, new_cap: newCap });
    expect(fake.state.requests.get(requestId).status).toBe('approved');

    const retried = await run(workflow, 'Every hour', [{}]);
    expect(retried.record.status).toBe('success');
    expect(retried.out('Plan the raise')[0].json).toMatchObject({ action: 'raise', newCap, attempts: 2 });
    expect(fake.state.requests.get(requestId).status).toBe('applied');
    expect(rowsOf('Landledger AI cap raises')[0]).toMatchObject({ status: 'applied', attempts: 2 });

    // A raise whose Mark Applied never landed: the cap already equals the target, so the reconcile only marks it applied.
    const other = await raiseWith(KEY, {
      kind: 'ai_budget', title: 'Raise Billing agent', costCenter: 'ENG-AGENTS', amount: { amount: '50.00', currency: 'USD' },
      requester: { kind: 'agent', agent: { id: 'ag_cool', name: 'Digest agent', system: 'landflow' }, sponsor: { email: 'eden.tzur@landbright.test' } },
      origin: { type: 'landflow_run', workflowId: workflow.id, executionId: 'ex_z' },
    });
    await confirm(other);
    await decide(other, 'approve');
    const table = dataTables().findTable('Landledger AI cap raises')!;
    dataTables().insertRows(table.id, [{ request_id: other, agent_id: 'ag_cool', month: month(), old_cap: 100, new_cap: 150, status: 'raising', attempts: 1, note: '', updated_at: new Date().toISOString() }]);
    const cool = agents.get('ag_cool')!;
    cool.settings = { ...cool.settings, monthlyCostLimit: 150 };
    cool.published = { ...(cool.published as JsonObject), config: { name: cool.name, instructions: cool.instructions, settings: { monthlyCostLimit: 150 } } };
    landflowCalls.length = 0;
    const reconciled = await run(workflow, 'Every hour', [{}]);
    expect(reconciled.out('Plan the raise').map((i) => [i.json.requestId, i.json.action])).toEqual([[other, 'markApplied']]);
    expect(landflowCalls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(fake.state.requests.get(other).status).toBe('applied');
  });

  it('a rejection holds the cap; an agent with unpublished edits is held for a person', async () => {
    const workflow = await install('landledger-ai-budget.json');
    bind(workflow.id);
    await run(workflow, 'Agent AI calls', [...calls(1), { kind: 'ai.call', agentId: 'ag_draft', cost: 1 }]);
    const [hot, draft] = [...fake.state.requests.keys()];
    for (const id of [hot, draft]) await confirm(id);
    await decide(hot, 'reject', 'Not this month');
    await decide(draft, 'approve');
    landflowCalls.length = 0;

    const rejected = await run(workflow, 'Request decided', [decided(hot, 'rejected')]);
    expect(rejected.ran('Hold the cap')).toBe(true);
    expect(rejected.ran('Get the request')).toBe(false);
    expect(landflowCalls).toHaveLength(0);

    const held = await run(workflow, 'Request decided', [decided(draft, 'approved')]);
    expect(held.out('Plan the raise')[0].json).toMatchObject({ action: 'hold', why: 'Billing agent has unpublished changes: raise the cap by hand, then mark the request applied' });
    expect(held.ran('Hold: raise by hand')).toBe(true);
    expect(landflowCalls.map((c) => c.method)).toEqual(['GET']);
    expect(fake.state.requests.get(draft).status).toBe('approved');
  });
});

describe('Landledger: ask the approver in Slack', () => {
  /** A pending infra_change request raised by Eden (confirmed), with Amit and Shira (in Slack) and someone without an email as approvers. */
  async function pending(stepKey = 'budget_owner', relayable = true) {
    const requestId = await raiseWith(KEY, {
      kind: 'infra_change',
      title: 'Second Postgres replica',
      costCenter: 'ENG-PLATFORM',
      amount: { amount: '1840.00', currency: 'USD' },
      note: 'Read load doubled',
      evidence: { lines: [{ label: 'db.r6g.large replica', amount: '1840.00' }], basis: 'AWS price list' },
      origin: { type: 'landflow_run', workflowId: 'wf_x', executionId: 'ex_x' },
      related: [{ type: 'pull_request', url: 'https://github.com/landfalls-ai/infra/pull/42' }],
    });
    await confirm(requestId);
    fake.state.requests.get(requestId).steps[0].key = stepKey;
    const request = fake.state.requests.get(requestId) as JsonObject;
    const event: JsonObject = {
      type: 'request.step_pending',
      id: 'evt_pending',
      timestamp: '2026-11-14T15:03:00.000Z',
      request: summaryOf(request),
      step: { position: 1, key: stepKey, label: stepKey === 'budget_owner' ? 'Budget owner' : 'Finance', groups: ['Budget Owners'], deadlineAt: '2026-11-16T15:03:00.000Z', escalated: false },
      approvers: [
        { name: 'Amit Gal', email: 'amit.gal@landbright.test', sub: 'sub-amit', via: 'group', group: 'Budget Owners' },
        { name: 'Someone', email: null, sub: 'sub-x', via: 'group', group: 'Budget Owners' },
      ],
      url: `http://localhost:4811/requests/${requestId}`,
      evidenceSha256: 'e'.repeat(64),
      relayable,
      requestId,
      kind: 'infra_change',
      costCenter: 'ENG-PLATFORM',
    };
    return { requestId, event };
  }

  /** Send the cards; the card Amit got (its channel, ts, blocks and the Approve button's value). */
  async function sendCards(workflow: Awaited<ReturnType<typeof install>>, event: JsonObject) {
    const sent = await run(workflow, 'Step waits on approvers', [event]);
    expect(sent.record.status).toBe('success');
    const post = slackCalls.find((c) => c.op === 'message.post')!;
    const blocks = post.parameters.blocksUi as JsonObject[];
    const approve = ((blocks.find((b) => b.type === 'actions')!.elements as JsonObject[]).find((a) => a.action_id === 'landledger.approve') ?? {}) as JsonObject;
    const { ts, channel } = sent.out('Send the card')[0].json as { ts: string; channel: string };
    slackCalls.length = 0;
    return { blocks, value: String(approve.value ?? ''), ts, channel, text: String(post.parameters.text) };
  }

  /** Slack's block_actions press on a card, signed with the relay channel's secret, as the Slack Trigger outputs it. */
  function press(card: { blocks: JsonObject[]; ts: string; channel: string; text: string }, options: { user?: string; value?: string; actionId?: string; team?: string; app?: string; ts?: string } = {}) {
    const user = options.user ?? 'U_AMIT';
    const team = options.team ?? SLACK_CHANNEL.teamId;
    const payload: JsonObject = {
      type: 'block_actions',
      team: { id: team, domain: 'landdev' },
      api_app_id: options.app ?? SLACK_CHANNEL.appId,
      user: { id: user, username: user.toLowerCase(), team_id: SLACK_PEOPLE[user]?.team_id ?? team },
      container: { type: 'message', channel_id: card.channel, message_ts: options.ts ?? card.ts },
      message: { ts: options.ts ?? card.ts, text: card.text, blocks: card.blocks },
      trigger_id: `trig_${user}_${Math.random().toString(36).slice(2)}`,
      response_url: 'https://hooks.slack.com/actions/T/1/x',
      actions: [{ type: 'button', action_id: options.actionId ?? 'landledger.approve', block_id: 'landledger_decision', value: options.value ?? (card as { value?: string }).value, action_ts: '1700000003.0' }],
    };
    const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
    const timestamp = String(Math.floor(Date.now() / 1000));
    return buttonPress(payload, { rawBody, signature: slackSignature(SLACK_CHANNEL.signingSecret, rawBody, timestamp), timestamp });
  }
  const relays = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/relays/slack');

  it('sends each approver with an email a recorded card: the evidence hash, Approve on the budget owner’s step, Reject and Open in Landledger', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, event } = await pending();
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
    // The hash Landledger served for the card, and what is decided where.
    const sha = String(fake.state.served.get(requestId)!.at(-1)!.sha);
    expect(text).toContain(`Evidence ${sha.slice(0, 12)}…`);
    expect(text).toContain('Finance and CFO steps are decided in Landledger, not Slack.');
    const actions = blocks.find((b) => b.type === 'actions')!.elements as JsonObject[];
    expect(actions.map((a) => a.action_id)).toEqual(['landledger.approve', 'landledger_reject', 'landledger_open']);
    expect(actions[0].value).toBe(`ll1|${requestId}|1|${sha}`);
    expect(actions[1]).toMatchObject({ url: event.url, text: { text: 'Reject in Landledger' } });
    expect(actions[2]).toMatchObject({ url: event.url });
    const { channel, ts } = sent.out('Send the card')[0].json as JsonObject;
    expect(rowsOf('Landledger Slack cards')).toEqual([expect.objectContaining({ request_id: requestId, step: 1, evidence_sha256: sha, channel, ts, approver: 'amit.gal@landbright.test' })]);
  });

  it('a Finance step gets a card without Approve: it is decided in Landledger', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { event } = await pending('finance', false);
    const card = await sendCards(workflow, event);
    const actions = card.blocks.find((b) => b.type === 'actions')!.elements as JsonObject[];
    expect(actions.map((a) => a.action_id)).toEqual(['landledger_open']);
    expect(JSON.stringify(card.blocks)).toContain('This step is decided in Landledger, not Slack.');
  });

  it('relays an Approve press on a recorded card exactly as Slack sent it, with the relay key; Landledger decides as the linked person', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, event } = await pending();
    const card = await sendCards(workflow, event);
    const item = press({ ...card, value: card.value } as never);
    const pressed = await run(workflow, 'Button pressed', [item]);
    expect(pressed.record.status).toBe('success');
    expect(relays()).toHaveLength(1);
    const relay = relays()[0];
    expect(relay.headers.authorization).toBe(`Bearer ${RELAY_KEY}`);
    const headers = item.headers as JsonObject;
    expect(relay.body).toEqual({ body: item.rawBody, signature: headers['x-slack-signature'], timestamp: headers['x-slack-request-timestamp'] });
    // The flow named nobody: Landledger mapped U_AMIT to Amit through his own link.
    expect(fake.state.requests.get(requestId)).toMatchObject({ status: 'approved', decisions: [{ person: { email: 'amit.gal@landbright.test' }, via: 'relay', relay: { externalUserId: 'U_AMIT' } }] });
    expect(slackCalls.map((c) => c.op)).toEqual(['user.get', 'message.update']);
    expect(slackCalls[1].parameters).toMatchObject({ channelId: card.channel, ts: card.ts });
    expect(String(slackCalls[1].parameters.text)).toMatch(/^✅ R-\d+ approved by Amit Gal · Second Postgres replica$/);
    const after = slackCalls[1].parameters.blocksUi as JsonObject[];
    expect((after.at(-1)!.elements as JsonObject[]).map((e) => e.action_id)).toEqual(['landledger_open']);
  });

  it('does not relay a press on a card it never sent, or one whose button does not match the card', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, event } = await pending();
    const card = await sendCards(workflow, event);
    const unknown = await run(workflow, 'Button pressed', [press({ ...card, value: card.value } as never, { ts: '1700000999.000001' })]);
    expect(unknown.record.status).toBe('success');
    expect(unknown.ran('Who pressed')).toBe(false);
    const swapped = await run(workflow, 'Button pressed', [press({ ...card, value: card.value } as never, { value: `ll1|${requestId}|1|${'d'.repeat(64)}` })]);
    expect(swapped.out('Check the card and who pressed')[0].json).toMatchObject({ ok: false, why: 'the button does not match the card this flow sent' });
    expect(relays()).toHaveLength(0);
    expect(fake.state.requests.get(requestId).status).toBe('pending');
  });

  it('does not relay a guest, someone from another organization, or a press from another team or app', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, event } = await pending();
    const card = await sendCards(workflow, event);
    const guest = await run(workflow, 'Button pressed', [press({ ...card, value: card.value } as never, { user: 'U_GUEST' })]);
    expect(guest.out('Check the card and who pressed')[0].json).toMatchObject({ ok: false, why: 'u_guest is a guest in this workspace' });
    expect(guest.ran('Not relayed')).toBe(true);
    const external = await run(workflow, 'Button pressed', [press({ ...card, value: card.value } as never, { user: 'U_EXT' })]);
    expect(external.out('Check the press')[0].json).toMatchObject({ ok: false, why: 'pressed by someone from another organization' });
    const otherApp = await run(workflow, 'Button pressed', [press({ ...card, value: card.value } as never, { app: 'A_SOMEONE_ELSE' })]);
    expect(String(otherApp.out('Check the press')[0].json.why)).toMatch(/another Slack team or app/);
    expect(otherApp.ran('Find the card')).toBe(false);
    expect(relays()).toHaveLength(0);
    expect(fake.state.requests.get(requestId).status).toBe('pending');
  });

  it('a press Landledger refuses (Tal is not an approver) says why on the card and keeps Open in Landledger', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, event } = await pending();
    const card = await sendCards(workflow, event);
    const refused = await run(workflow, 'Button pressed', [press({ ...card, value: card.value } as never, { user: 'U_TAL' })]);
    expect(refused.record.status).toBe('success');
    expect(relays()).toHaveLength(1);
    expect(fake.state.requests.get(requestId).status).toBe('pending');
    const update = slackCalls.find((c) => c.op === 'message.update')!;
    expect(String(update.parameters.text)).toMatch(/^⚠️ R-\d+: Landledger did not take your answer: This step is for Budget Owners; tal\.levi@landbright\.test isn't in it$/);
    const blocks = update.parameters.blocksUi as JsonObject[];
    expect((blocks.at(-1)!.elements as JsonObject[]).map((e) => [e.action_id, e.url])).toEqual([['landledger_open', event.url]]);
  });

  it('when Landledger is down the card keeps its buttons and says Try again', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, event } = await pending();
    const card = await sendCards(workflow, event);
    fake.failNext(503, { error: { code: 'unavailable', message: 'The database is down' } });
    await run(workflow, 'Button pressed', [press({ ...card, value: card.value } as never)]);
    const update = slackCalls.find((c) => c.op === 'message.update')!;
    const blocks = update.parameters.blocksUi as JsonObject[];
    expect(JSON.stringify(blocks[0])).toMatch(/Landledger did not answer \(Landledger API error 503: The database is down\)\. Try again\./);
    expect((blocks.at(-1)!.elements as JsonObject[]).map((e) => e.action_id)).toEqual(['landledger.approve', 'landledger_reject', 'landledger_open']);
    expect(fake.state.requests.get(requestId).status).toBe('pending');
  });

  it('a stale card (Landledger’s 409) is rebuilt with a fresh evidence hash, recorded, and pressed again', async () => {
    const workflow = await install('landledger-slack-approver.json');
    const { requestId, event } = await pending();
    const card = await sendCards(workflow, event);
    // The card was served more than 30 minutes ago.
    for (const served of fake.state.served.get(requestId)!) served.at -= 31 * 60 * 1000;
    const stale = await run(workflow, 'Button pressed', [press({ ...card, value: card.value } as never)]);
    expect(stale.record.status).toBe('success');
    expect(fake.state.requests.get(requestId).status).toBe('pending');
    const update = slackCalls.find((c) => c.op === 'message.update')!;
    const blocks = update.parameters.blocksUi as JsonObject[];
    expect(JSON.stringify(blocks[0])).toContain('The request changed or this card was older than 30 minutes');
    const fresh = String(fake.state.served.get(requestId)!.at(-1)!.sha);
    const approve = (blocks.at(-1)!.elements as JsonObject[])[0];
    expect(approve).toMatchObject({ action_id: 'landledger.approve', value: `ll1|${requestId}|1|${fresh}` });
    expect(rowsOf('Landledger Slack cards')[0]).toMatchObject({ evidence_sha256: fresh, channel: card.channel, ts: card.ts });

    slackCalls.length = 0;
    const again = await run(workflow, 'Button pressed', [press({ ...card, blocks, value: String(approve.value) } as never)]);
    expect(again.record.status).toBe('success');
    expect(fake.state.requests.get(requestId).status).toBe('approved');
  });
});
