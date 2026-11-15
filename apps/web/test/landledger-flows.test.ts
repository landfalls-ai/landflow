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
import { landledgerApi, LandledgerNode, landledgerNotesKey, landledgerRelayApi } from '../../../plugins/landledger/src/nodes/landledger';
import { Landfall, landfallApi, landfallHeartbeatApi } from '../../../plugins/landfall/src/nodes/landfall';
import { LandfallTrigger } from '../../../plugins/landfall/src/nodes/landfall-trigger';
import { SEED as LANDFALL_SEED, startFakeLandfall, type FakeLandfall } from '../../../plugins/landfall/test/fake-landfall';
import { LandledgerTrigger } from '../../../plugins/landledger/src/nodes/landledger-trigger';
import { KEY, NOTE_FIGURES, NOTES_KEY, NOTES_MONTH, OTHER_KEY, RELAY_KEY, SLACK_CHANNEL, SNAPSHOT_SHA, startFakeLandledger, WEBHOOKS_KEY, type FakeLandledger } from '../../../plugins/landledger/test/fake-landledger';
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
const landfallManifest = JSON.parse(readFileSync(join(fixtures, 'landfall.json'), 'utf8'));

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
  definePlugin({ info: landledgerManifest.plugin, nodes: [LandledgerNode, LandledgerTrigger], credentialTypes: [landledgerApi, landledgerRelayApi, landledgerNotesKey], iconDir: new URL('../../../plugins/landledger/icons/', import.meta.url) }) as IPlugin,
);
registry.registerBuiltin(
  definePlugin({ info: landfallManifest.plugin, nodes: [Landfall, LandfallTrigger], credentialTypes: [landfallApi, landfallHeartbeatApi], iconDir: new URL('../../../plugins/landfall/icons/', import.meta.url) }) as IPlugin,
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

describe('Landledger: tool or seat cost', () => {
  // ---- Landbright's machine API with spec 008 (PR #5), as the HTTP Request nodes see it: client credentials, requests
  // with their costs and cost gate, annotations, and the gate's settle route with Landbright's rules (only while pending
  // at the gate; the same answer again 200, another 409; break-glass skipped it, 409).
  interface LbCall { method: string; path: string; auth: string; body: JsonObject | null }
  const lbCalls: LbCall[] = [];
  const lbRequests = new Map<string, JsonObject>();
  /** Grants as GET /api/v1/grants/:id answers (requests:read). */
  const lbGrants = new Map<string, JsonObject>();
  const LB_ID = '0b6c2a52-6c55-4a39-9a77-6a1c3a7e0041';
  let lbUrl = '';
  const landbright = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const raw = await readBody(req);
    const send = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (url.pathname === '/oauth/token') {
      const form = new URLSearchParams(raw);
      const basic = Buffer.from(String(req.headers.authorization ?? '').replace(/^Basic /, ''), 'base64').toString();
      const client = basic.includes(':') ? basic : `${form.get('client_id')}:${form.get('client_secret')}`;
      if (form.get('grant_type') !== 'client_credentials' || client !== 'landflow-local:landbright-dev-secret') return send(401, { error: 'invalid_client' });
      return send(200, { access_token: 'lb_token_1', token_type: 'Bearer', expires_in: 3600 });
    }
    const body = raw ? (JSON.parse(raw) as JsonObject) : null;
    lbCalls.push({ method: req.method ?? '', path: url.pathname, auth: String(req.headers.authorization ?? ''), body });
    if (req.headers.authorization !== 'Bearer lb_token_1') return send(401, { message: 'Unauthorized' });
    const g = /^\/api\/v1\/grants\/([^/]+)$/.exec(url.pathname);
    if (g && req.method === 'GET') return lbGrants.has(g[1]) ? send(200, lbGrants.get(g[1])) : send(404, { message: 'Not found' });
    const m = /^\/api\/v1\/requests\/([^/]+)(?:\/(annotations|steps)\/([^/]+)(\/settle)?)?$/.exec(url.pathname);
    const request = m ? [...lbRequests.values()].find((r) => r.id === m[1] || r.ref === m[1]) : undefined;
    if (!request) return send(404, { message: 'Not found' });
    if (req.method === 'GET' && !m![2]) return send(200, request);
    if (req.method === 'PUT' && m![2] === 'annotations') {
      (request.annotations as JsonObject)[m![3]] = body?.value ?? null;
      return send(200, { key: m![3], value: body?.value ?? null, version: 1 });
    }
    if (req.method === 'POST' && m![2] === 'steps' && m![4]) {
      const steps = request.steps as JsonObject[];
      const at = Number(m![3]);
      const gate = steps[at];
      if (request.conflict) return send(409, { message: String(request.conflict) });
      if (!gate || gate.kind !== 'external') return send(409, { message: `Step ${at} is not settled by a system` });
      const settlement = gate.settlement as JsonObject | null;
      if (settlement) return settlement.outcome === body?.outcome ? send(200, request) : send(409, { message: `Step ${at} was settled already: ${String(settlement.outcome)}` });
      if (request.status !== 'pending' || request.currentStep !== at) return send(409, { message: request.method === 'break_glass' ? `Step ${at} was skipped: break-glass` : `${String(request.ref)} is ${String(request.status)}` });
      gate.settlement = { outcome: body?.outcome, reference: body?.reference, reason: body?.reason ?? null, by: 'landflow-local', at: '2026-11-15T09:30:00.000Z' };
      if (body?.outcome === 'approve') Object.assign(request, { currentStep: at + 1, waitingOnSystem: null });
      else Object.assign(request, { status: 'denied', closingReason: 'step_denied', waitingOnSystem: null });
      return send(200, request);
    }
    send(404, { message: 'Not found' });
  });
  const person = { id: 'f3a0c1de-1111-4a39-9a77-6a1c3a7e0001', kind: 'person', displayName: 'Tal Levi', email: 'tal.levi@landbright.test', status: 'active' };
  const gateStep = () => ({ kind: 'external', name: 'Cost', approvalsRequired: 0, approvals: 0, approvers: [], allowRelayed: false, system: 'Landledger', settledBy: 'landflow-local', settlement: null });
  const peopleStep = { kind: 'people', name: 'Tool owner', approvalsRequired: 1, approvals: 0, approvers: [], allowRelayed: true, system: null, settledBy: null, settlement: null };
  /** A Landbright request as GET /api/v1/requests/:id answers with spec 008: a Linear seat, the gate waiting on Landledger. */
  function lbRequest(overrides: JsonObject = {}): JsonObject {
    const request = {
      id: LB_ID, number: 41, ref: 'REQ-41', bundle: { id: 'b1', name: 'Linear' }, requester: person, subject: person, actingFor: null, extends: null,
      status: 'pending', method: null, currentStep: 0, steps: [gateStep(), structuredClone(peopleStep)], waitingOnSystem: 'Landledger',
      costs: [{ target: 't1', label: 'Linear workspace', kind: 'seat', landbrightApp: 'linear' }], breakGlass: null,
      grant: null, decisionUrl: 'http://localhost:5173/access/requests/REQ-41', annotations: {}, createdAt: '2026-11-15T09:00:00.000Z', decidedAt: null,
      ...overrides,
    };
    lbRequests.set(String(request.id), request);
    return request;
  }
  /** What Landbright's Webhook trigger delivers: the signed event, in jwtPayload. */
  const lbEvent = (type: string, data: JsonObject = {}, requestId = LB_ID) => ({
    headers: {}, params: {}, query: {}, body: {},
    jwtPayload: { iss: 'http://127.0.0.1:4401', event: { id: `evt_${type}`, type, at: '2026-11-15T09:00:00.000Z', target: { type: type.startsWith('grant.') ? 'grant' : 'request', id: type.startsWith('grant.') ? 'grant-1' : requestId }, data } },
  });
  const created = (requestId = LB_ID) => lbEvent('request.created', { ref: 'REQ-41', costs: ['linear'], waitsOn: 'Landledger' }, requestId);
  const LB_ID_2 = '0b6c2a52-6c55-4a39-9a77-6a1c3a7e0042';
  const second = { id: LB_ID_2, number: 42, ref: 'REQ-42', decisionUrl: 'http://localhost:5173/access/requests/REQ-42' };
  /** An extension of REQ-41's grant: seven more days. */
  const LB_ID_3 = '0b6c2a52-6c55-4a39-9a77-6a1c3a7e0043';
  const extension = { id: LB_ID_3, number: 43, ref: 'REQ-43', decisionUrl: 'http://localhost:5173/access/requests/REQ-43', extends: { grantId: 'grant-1', ref: 'REQ-41' }, durationMinutes: 7 * 24 * 60 };
  const createdPosts = () => fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/requests');
  /** As if the run that raised them stopped before recording them. */
  const clearSeatRows = () => {
    for (const name of ['Landledger seat requests', 'Landledger unpaid seats']) {
      const table = dataTables().findTable(name);
      if (table) dataTables().deleteRows(table.id, { type: 'and', conditions: [{ column: 'id', operator: 'isNotEmpty', value: '' }] });
    }
  };
  /** REQ-41 raised, its cost approved, its grant (grant-1) live and its seat in use. */
  async function seatInUse(workflow: Awaited<ReturnType<typeof install>>, expiresAt: string) {
    const id = await raised(workflow);
    await costDecided(id, 'approve');
    lbRequest({ status: 'approved', currentStep: 1, waitingOnSystem: null, grant: { id: 'grant-1', status: 'active' } });
    await run(workflow, 'Landbright events', [lbEvent('grant.activated', { requestId: LB_ID })]);
    expect(fake.state.requests.get(id).seat.status).toBe('applied');
    lbGrants.set('grant-1', { id: 'grant-1', status: 'active', expiresAt, isBreakGlass: false });
    return id;
  }
  const annotations = () => lbCalls.filter((c) => c.method === 'PUT').map((c) => (c.body as JsonObject).value as JsonObject);
  const settles = () => lbCalls.filter((c) => c.path.endsWith('/settle'));

  async function installSeat(settle = false, seatApps = '{}') {
    const workflow = await install('landledger-tool-or-seat.json');
    const settings = workflow.nodes.find((n) => n.name === 'Settings')!;
    settings.parameters.codeEach = String(settings.parameters.codeEach)
      .replace("const LANDBRIGHT_URL = 'http://127.0.0.1:4401';", `const LANDBRIGHT_URL = '${lbUrl}';`)
      .replace('const SEAT_APPS = {};', `const SEAT_APPS = ${seatApps};`)
      .replace('const SETTLE_IN_LANDBRIGHT = false;', `const SETTLE_IN_LANDBRIGHT = ${settle};`);
    store.saveWorkflow(workflow);
    return store.getWorkflow(workflow.id)!;
  }
  /** Landbright's request.created raises the seat request: its id. */
  async function raised(workflow: Awaited<ReturnType<typeof install>>, overrides: JsonObject = {}) {
    const request = lbRequest(overrides);
    const { record } = await run(workflow, 'Landbright events', [created(String(request.id))]);
    expect(record.status).toBe('success');
    return [...fake.state.requests.keys()].at(-1)!;
  }
  /** The person confirmed it, and the budget owner decided. */
  async function costDecided(id: string, outcome: 'approve' | 'reject', comment = '') {
    fake.state.requests.get(id).status = 'pending';
    await decide(id, outcome, comment);
  }
  /** Landledger's request.decided, as the Landledger Trigger outputs it. */
  const llDecided = (id: string, outcome: 'approved' | 'rejected') => decided(id, outcome);

  beforeAll(async () => {
    await new Promise<void>((resolve) => landbright.listen(0, '127.0.0.1', resolve));
    lbUrl = `http://127.0.0.1:${(landbright.address() as AddressInfo).port}`;
    slots.landbright = credentials.create({ name: 'Landbright API (test)', type: 'core.oAuth2Api', data: { grantType: 'clientCredentials', accessTokenUrl: `${lbUrl}/oauth/token`, clientId: 'landflow-local', clientSecret: 'landbright-dev-secret' } as JsonObject }).id;
    slots.landbrightEvents = credentials.create({ name: 'Landbright events (test)', type: 'core.jwtAuth', data: { keyType: 'jwks', jwksUrl: `${lbUrl}/jwks` } as JsonObject }).id;
  });
  afterAll(() => new Promise((resolve) => landbright.close(resolve)));
  beforeEach(() => {
    lbCalls.length = 0;
    lbRequests.clear();
    lbGrants.clear();
    clearSeatRows();
  });

  it('a Landbright request whose cost is a seat raises one tool_or_seat request on the contract, naming the person, and notes it in Landbright', async () => {
    const workflow = await installSeat();
    const id = await raised(workflow);
    expect(fake.requests.find((r) => r.path === '/api/contracts/seats')!.query).toEqual({ landbrightApp: 'linear' });
    const createdCall = fake.requests.find((r) => r.method === 'POST' && r.path === '/api/requests')!;
    expect(createdCall.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(createdCall.body).toMatchObject({
      kind: 'tool_or_seat',
      title: 'Linear seat for Tal Levi (REQ-41)',
      costCenter: 'ENG-PLATFORM',
      amount: { amount: '12.5', currency: 'USD' },
      recurrence: 'monthly',
      seat: { contractId: 'con_linear', seats: 1, seatPrice: '12.5' },
      requester: { kind: 'person', person: { sub: person.id } },
      related: [{ type: 'landbright_request', id: 'REQ-41', url: 'http://localhost:5173/access/requests/REQ-41' }],
      origin: { type: 'landflow_run', workflowId: workflow.id, title: 'Tool or seat cost (Landbright REQ-41)' },
      evidence: { lines: [{ label: 'Linear Business seat', amount: '12.500000' }], links: [{ label: 'REQ-41', url: 'http://localhost:5173/access/requests/REQ-41' }] },
      idempotencyKey: 'landbright-REQ-41',
    });
    expect(rowsOf('Landledger seat requests')).toEqual([expect.objectContaining({ landbright_request_id: LB_ID, landbright_ref: 'REQ-41', landledger_request_id: id, app: 'linear', workflow_id: workflow.id })]);
    expect(lbCalls.map((c) => [c.method, c.path, c.auth])).toEqual([
      ['GET', `/api/v1/requests/${LB_ID}`, 'Bearer lb_token_1'],
      ['PUT', `/api/v1/requests/${LB_ID}/annotations/landflow.seat_cost`, 'Bearer lb_token_1'],
    ]);
    expect(annotations()[0]).toMatchObject({ status: 'cost_asked', landledgerRequestId: id, text: expect.stringContaining('asked in Landledger as R-1; its approvers decide the cost') });
  });

  it('raises nothing without a seat cost, for a request no longer pending, or for an extension decided without a new grant; no contract is said in Landbright; SEAT_APPS stands in for an older Landbright', async () => {
    const workflow = await installSeat();
    for (const overrides of [{ costs: [], steps: [structuredClone(peopleStep)], waitingOnSystem: null }, { status: 'approved', method: 'reviewed' }, { status: 'approved', extends: { grantId: 'g0', ref: 'REQ-40' }, grant: { id: 'g0', status: 'active' } }]) {
      lbRequest(overrides);
      expect((await run(workflow, 'Landbright events', [lbEvent('request.created')])).record.status).toBe('success');
    }
    expect(fake.requests.filter((r) => r.path.startsWith('/api/contracts') || r.path === '/api/requests')).toHaveLength(0);
    expect(annotations()).toHaveLength(0);

    lbRequest({ costs: [{ target: 't3', label: 'Figma', kind: 'seat', landbrightApp: 'figma' }] });
    const { ran } = await run(workflow, 'Landbright events', [lbEvent('request.created')]);
    expect(ran('No contract: say so in Landbright')).toBe(true);
    expect(fake.requests.some((r) => r.method === 'POST' && r.path === '/api/requests')).toBe(false);
    expect(annotations()).toEqual([expect.objectContaining({ status: 'no_contract', app: 'figma', text: expect.stringContaining('No Landledger contract grants figma') })]);

    // A Landbright without spec 008 says nothing of costs: SEAT_APPS maps the bundle.
    const older = await installSeat(false, "{ 'Linear (seat)': 'linear' }");
    lbRequest({ bundle: { id: 'b1', name: 'Linear (seat)' }, costs: undefined, steps: [structuredClone(peopleStep)], waitingOnSystem: undefined });
    await run(older, 'Landbright events', [lbEvent('request.created')]);
    expect(fake.requests.filter((r) => r.method === 'POST' && r.path === '/api/requests')).toHaveLength(1);
  });

  it('with the setting off, notes Landledger’s decision on the Landbright request and settles nothing', async () => {
    const workflow = await installSeat();
    const id = await raised(workflow);
    await costDecided(id, 'approve');
    lbCalls.length = 0;
    const approved = await run(workflow, 'Landledger events', [llDecided(id, 'approved')]);
    expect(approved.out('Ours to act on?')[0].json).toMatchObject({ route: 0, outcome: 'approved', landbrightRequestId: LB_ID, seat: { status: 'reserved' } });
    expect(annotations()).toEqual([expect.objectContaining({ status: 'cost_approved', landledgerRequestId: id, text: expect.stringContaining('the seat is reserved') })]);
    expect(approved.out('What Landbright needs')[0].json).toMatchObject({ route: 2, why: 'SETTLE_IN_LANDBRIGHT is off: REQ-41 waits on Landledger until its gate\'s deadline' });
    expect(approved.ran('Nothing to settle')).toBe(true);
    expect(settles()).toHaveLength(0);
  });

  it('settles the cost gate (step 0) with the outcome and a Landledger reference; a redelivered decision settles nothing twice', async () => {
    const workflow = await installSeat(true);
    const id = await raised(workflow);
    await costDecided(id, 'approve');
    lbCalls.length = 0;
    const approved = await run(workflow, 'Landledger events', [llDecided(id, 'approved')]);
    expect(settles()).toEqual([expect.objectContaining({
      method: 'POST',
      path: `/api/v1/requests/${LB_ID}/steps/0/settle`,
      auth: 'Bearer lb_token_1',
      body: { outcome: 'approve', reference: { system: 'Landledger', id, url: `http://localhost:4811/requests/${id}` } },
    })]);
    expect(approved.out('Settled?')[0].json).toMatchObject({ ref: 'REQ-41', outcome: 'approve', settled: true });
    expect(lbRequests.get(LB_ID)).toMatchObject({ status: 'pending', currentStep: 1, waitingOnSystem: null });

    lbCalls.length = 0;
    const again = await run(workflow, 'Landledger events', [llDecided(id, 'approved')]);
    expect(again.out('What Landbright needs')[0].json).toMatchObject({ route: 2, why: expect.stringContaining("REQ-41's gate was settled already (approve") });
    expect(settles()).toHaveLength(0);

    // Rejected: deny, with the approver's reason; Landbright ends the request.
    const rejected = await raised(workflow, second);
    await costDecided(rejected, 'reject', 'Use the free plan');
    lbCalls.length = 0;
    await run(workflow, 'Landledger events', [llDecided(rejected, 'rejected')]);
    expect(annotations()).toEqual([expect.objectContaining({ status: 'cost_denied', reason: 'Amit Gal: Use the free plan' })]);
    expect(settles()[0]).toMatchObject({ path: `/api/v1/requests/${LB_ID_2}/steps/0/settle`, body: { outcome: 'deny', reference: { system: 'Landledger', id: rejected }, reason: 'Amit Gal: Use the free plan' } });
    expect(lbRequests.get(LB_ID_2)).toMatchObject({ status: 'denied', closingReason: 'step_denied' });
  });

  it('a 409 from the settle route (the request moved on meanwhile) is said, not retried', async () => {
    const workflow = await installSeat(true);
    const id = await raised(workflow);
    await costDecided(id, 'approve');
    lbRequests.get(LB_ID)!.conflict = 'REQ-41 is expired';
    const { record, out } = await run(workflow, 'Landledger events', [llDecided(id, 'approved')]);
    expect(record.status).toBe('success');
    expect(out('Settled?')[0].json).toMatchObject({ settled: false, why: 'HTTP 409' });
    expect(settles()).toHaveLength(1);
  });

  it('break-glass: Landbright granted first and skipped the gate; the cost is raised as break-glass, never settled, and marked used once approved', async () => {
    const workflow = await installSeat(true);
    const breakGlass = { status: 'approved', method: 'break_glass', breakGlass: { reason: 'Prod incident', reviewDueAt: '2026-11-16T09:00:00.000Z' }, currentStep: 0, waitingOnSystem: null, grant: { id: 'grant-1', status: 'active' }, decidedAt: '2026-11-15T09:00:00.000Z' };
    const id = await raised(workflow, breakGlass);
    const createdCall = fake.requests.find((r) => r.method === 'POST' && r.path === '/api/requests')!;
    expect(createdCall.body).toMatchObject({
      origin: { type: 'landbright_request', id: 'REQ-41', url: 'http://localhost:5173/access/requests/REQ-41', breakGlass: true },
      related: [{ type: 'landflow_run', workflowId: workflow.id }],
      idempotencyKey: 'landbright-REQ-41',
    });
    expect(annotations()[0]).toMatchObject({ status: 'cost_asked', text: expect.stringContaining('after break-glass granted the access') });

    await costDecided(id, 'approve');
    lbCalls.length = 0;
    const approved = await run(workflow, 'Landledger events', [llDecided(id, 'approved')]);
    expect(approved.out('Ours to act on?')[0].json).toMatchObject({ route: 0, breakGlass: true });
    expect(approved.out('What Landbright needs')[0].json).toMatchObject({ route: 1 });
    expect(settles()).toHaveLength(0);
    expect(fake.state.requests.get(id)).toMatchObject({ status: 'applied', seat: { status: 'applied' }, appliedNote: 'Granted in Landbright as REQ-41 under break-glass; the cost was approved after' });
  });

  it('refuses a decision on a seat request another key raised, naming this workflow', async () => {
    const workflow = await installSeat(true);
    const raisedHere = await raised(workflow);
    const forged = await raiseWith(OTHER_KEY, { kind: 'tool_or_seat', title: 'Forged seat', costCenter: 'ENG-PLATFORM', amount: { amount: '12.5', currency: 'USD' }, origin: { type: 'landflow_run', workflowId: workflow.id, executionId: fake.state.requests.get(raisedHere).origin.executionId } });
    await costDecided(forged, 'approve');
    lbCalls.length = 0;
    const refused = await run(workflow, 'Landledger events', [llDecided(forged, 'approved')]);
    expect(refused.out('Ours to act on?')[0].json).toMatchObject({ route: 2, why: expect.stringMatching(/raised by Someone else, not this flow's key/) });
    expect(refused.ran("Not this flow's: refused")).toBe(true);
    expect(lbCalls).toHaveLength(0);
  });

  it('marks the seat used on grant.activated, releases it when access is denied, and when the grant is revoked', async () => {
    const workflow = await installSeat();
    const id = await raised(workflow);
    await costDecided(id, 'approve');
    lbRequest({ status: 'approved', currentStep: 1, waitingOnSystem: null, grant: { id: 'grant-1', status: 'active' } });
    const granted = await run(workflow, 'Landbright events', [lbEvent('grant.activated', { requestId: LB_ID, subjectId: person.id, expiresAt: '2026-12-15T09:00:00.000Z' })]);
    expect(granted.out('What the seat needs')[0].json).toMatchObject({ action: 'apply' });
    expect(fake.state.requests.get(id)).toMatchObject({ status: 'applied', seat: { status: 'applied' }, appliedNote: 'Granted in Landbright as REQ-41', appliedLinks: [{ label: 'REQ-41', url: 'http://localhost:5173/access/requests/REQ-41' }] });

    lbRequest({ status: 'approved', currentStep: 1, waitingOnSystem: null, grant: { id: 'grant-1', status: 'revoked' } });
    await run(workflow, 'Landbright events', [lbEvent('grant.revoked', { requestId: LB_ID })]);
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: `/api/requests/${id}/seats/release`, body: { reason: 'grant_revoked', note: 'Grant revoked in Landbright (REQ-41)' } });
    expect(fake.state.requests.get(id).seat.status).toBe('released');

    // Another request: the cost approved, then Landbright's approvers deny the access.
    const denied = await raised(workflow, second);
    await costDecided(denied, 'approve');
    lbRequest({ ...second, status: 'denied', currentStep: 1, waitingOnSystem: null, decidedAt: '2026-11-15T10:00:00.000Z' });
    const access = await run(workflow, 'Landbright events', [lbEvent('request.decided', { outcome: 'denied' }, LB_ID_2)]);
    expect(access.out('What the seat needs')[0].json).toMatchObject({ action: 'release', reason: 'access_denied' });
    expect(fake.state.requests.get(denied).seat).toMatchObject({ status: 'released', releasedReason: 'access_denied' });
  });

  it('a gate that ran out waiting on Landledger: an undecided cost request is cancelled, an approved one releases its seat', async () => {
    const workflow = await installSeat();
    const id = await raised(workflow);
    lbRequest({ status: 'expired', closingReason: 'expired', decidedAt: '2026-11-16T09:00:00.000Z' });
    const expired = await run(workflow, 'Landbright events', [lbEvent('request.decided', { ref: 'REQ-41', outcome: 'expired', step: 'Cost', waitedOn: 'Landledger' })]);
    expect(expired.out('What the seat needs')[0].json).toMatchObject({ action: 'cancel', reason: "Landbright's REQ-41 expired waiting on Landledger: the seat isn't needed" });
    expect(fake.requests.at(-1)).toMatchObject({ method: 'POST', path: `/api/requests/${id}/cancel`, body: { reason: "Landbright's REQ-41 expired waiting on Landledger: the seat isn't needed" } });
    expect(fake.state.requests.get(id).status).toBe('cancelled');

    // Landledger approved, but the gate ran out before the flow settled it (the setting off): the seat goes back.
    const approved = await raised(workflow, second);
    await costDecided(approved, 'approve');
    lbRequest({ ...second, status: 'expired', decidedAt: '2026-11-16T09:00:00.000Z' });
    await run(workflow, 'Landbright events', [lbEvent('request.decided', { ref: 'REQ-42', outcome: 'expired', step: 'Cost', waitedOn: 'Landledger' }, LB_ID_2)]);
    expect(fake.state.requests.get(approved).seat).toMatchObject({ status: 'released', releasedReason: 'access_denied', releaseNote: 'Access expired waiting on Landledger in Landbright (REQ-42)' });
  });

  it('a redelivered request.created raises nothing twice: Landledger’s 409 names the request, which keeps its one row', async () => {
    const workflow = await installSeat();
    const id = await raised(workflow);
    const again = await run(workflow, 'Landbright events', [created()]);
    expect(again.record.status).toBe('success');
    expect(again.out('Seat request in hand')[0].json).toMatchObject({ landledgerRequestId: id, recovered: true, executionId: fake.state.requests.get(id).origin.executionId });
    expect(fake.state.requests.size).toBe(1);
    expect(rowsOf('Landledger seat requests')).toHaveLength(1);
  });

  it('review 15: a run that stopped between Create and its row: the next delivery’s 409 finds the request and records it with the run that raised it, so its decision is acted on', async () => {
    const workflow = await installSeat();
    const id = await raised(workflow);
    const raisedBy = String(fake.state.requests.get(id).origin.executionId);
    clearSeatRows();
    // Before the fix: no row, so the decision was refused as "no run of this workflow raised it".
    await costDecided(id, 'approve');
    expect((await run(workflow, 'Landledger events', [llDecided(id, 'approved')])).out('Ours to act on?')[0].json).toMatchObject({ route: 2, why: 'no run of this workflow raised it' });
    fake.state.requests.get(id).status = 'awaiting_confirmation';
    lbCalls.length = 0;
    const again = await run(workflow, 'Landbright events', [created()]);
    expect(again.out('Asked, or already asked')[0].json).toMatchObject({ route: 1, existingId: id });
    expect(again.ran("This key's seat requests")).toBe(false);
    expect(rowsOf('Landledger seat requests')).toEqual([expect.objectContaining({ landbright_request_id: LB_ID, landbright_ref: 'REQ-41', landledger_request_id: id, execution_id: raisedBy })]);
    expect(annotations()).toEqual([expect.objectContaining({ status: 'cost_asked', landledgerRequestId: id })]);
    await costDecided(id, 'approve');
    expect((await run(workflow, 'Landledger events', [llDecided(id, 'approved')])).out('Ours to act on?')[0].json).toMatchObject({ route: 0, landbrightRequestId: LB_ID });

    // A Landledger whose 409 names no request: found by its origin among this key's seat requests. Decided already, it
    // gets no "cost asked" note (the reconcile tells Landbright the decision).
    clearSeatRows();
    fake.state.conflictNamesRequest = false;
    lbCalls.length = 0;
    const older = await run(workflow, 'Landbright events', [created()]);
    expect(older.out('Asked, or already asked')[0].json).toMatchObject({ route: 2, existingId: null });
    expect(older.out('Which request was it')[0].json).toEqual({ requestId: id });
    expect(rowsOf('Landledger seat requests')).toEqual([expect.objectContaining({ landledger_request_id: id, execution_id: raisedBy })]);
    expect(older.ran('Note it in Landbright')).toBe(false);
    expect(annotations()).toHaveLength(0);
  });

  it('review 15: every hour, a seat request with no row is recorded, a decision Landbright was never told is noted and acted on, and a cost request whose Landbright request ended before its row is cancelled', async () => {
    const workflow = await installSeat();
    const approved = await raised(workflow);
    const raced = await raised(workflow, second);
    for (const id of [approved, raced]) fake.state.requests.get(id).createdAt = new Date().toISOString();
    clearSeatRows();
    await costDecided(approved, 'approve');
    // Both decision events came while there was no row: refused. REQ-41 is granted; REQ-42 was cancelled in Landbright.
    await run(workflow, 'Landledger events', [llDecided(approved, 'approved')]);
    lbRequest({ status: 'approved', currentStep: 1, waitingOnSystem: null, grant: { id: 'grant-1', status: 'active' } });
    lbRequest({ ...second, status: 'cancelled', closingReason: 'cancelled', decidedAt: '2026-11-15T10:00:00.000Z' });
    expect((await run(workflow, 'Landbright events', [lbEvent('request.decided', { outcome: 'cancelled' }, LB_ID_2)])).ran('Read the access request')).toBe(false);
    lbCalls.length = 0;

    const hour = await run(workflow, 'Every hour', [{ scheduledAt: '2026-11-15T11:00:00.000Z' }]);
    expect(hour.record.status).toBe('success');
    expect(hour.out('Plan the reconcile').map((i) => [i.json.number, i.json.action])).toEqual([
      [fake.state.requests.get(raced).number, 'remember'],
      [fake.state.requests.get(raced).number, 'cancel'],
      [fake.state.requests.get(approved).number, 'remember'],
      [fake.state.requests.get(approved).number, 'note'],
      [fake.state.requests.get(approved).number, 'apply'],
    ]);
    expect(rowsOf('Landledger seat requests').map((r) => [r.landbright_ref, r.landledger_request_id, r.execution_id]).sort()).toEqual([
      ['REQ-41', approved, fake.state.requests.get(approved).origin.executionId],
      ['REQ-42', raced, fake.state.requests.get(raced).origin.executionId],
    ]);
    expect(annotations()).toEqual([expect.objectContaining({ status: 'cost_approved', landledgerRequestId: approved })]);
    expect(fake.state.requests.get(approved)).toMatchObject({ status: 'applied', seat: { status: 'applied' }, appliedNote: 'Granted in Landbright as REQ-41 (found by the hourly reconcile)' });
    expect(fake.state.requests.get(raced)).toMatchObject({ status: 'cancelled' });
    expect(settles()).toHaveLength(0);

    // The next hour finds nothing left to do.
    lbCalls.length = 0;
    const writes = fake.requests.filter((r) => r.method === 'POST').length;
    const next = await run(workflow, 'Every hour', [{ scheduledAt: '2026-11-15T12:00:00.000Z' }]);
    expect(next.ran('Get each seat request')).toBe(false);
    expect(lbCalls).toHaveLength(0);
    expect(fake.requests.filter((r) => r.method === 'POST').length).toBe(writes);
  });

  it('review 16: a break-glass seat whose cost Landledger rejects: Landbright has no route to revoke a grant, so its approvers get a task, and the seat counts as in use, unpaid, until the grant is revoked', async () => {
    const workflow = await installSeat(true);
    const amit = { id: 'p-amit', kind: 'person', displayName: 'Amit Gal', email: 'amit.gal@landbright.test', status: 'active' };
    const breakGlass = { status: 'approved', method: 'break_glass', breakGlass: { reason: 'Prod incident' }, currentStep: 0, waitingOnSystem: null, grant: { id: 'grant-1', status: 'active' }, steps: [gateStep(), { ...structuredClone(peopleStep), approvers: [amit] }] };
    const id = await raised(workflow, breakGlass);
    await costDecided(id, 'reject', 'No budget for Linear this quarter');
    lbCalls.length = 0;
    const rejected = await run(workflow, 'Landledger events', [llDecided(id, 'rejected')]);
    expect(rejected.out('What Landbright needs')[0].json).toMatchObject({ route: 3, approvers: [{ name: 'Amit Gal', email: 'amit.gal@landbright.test' }] });
    expect(settles()).toHaveLength(0);
    expect(lbCalls.filter((c) => c.method !== 'GET').map((c) => c.path)).toEqual([
      `/api/v1/requests/${LB_ID}/annotations/landflow.seat_cost`,
      `/api/v1/requests/${LB_ID}/annotations/landflow.seat_revoke`,
    ]);
    const task = annotations()[1];
    expect(task).toMatchObject({
      status: 'open', task: 'revoke_grant', assignees: [{ name: 'Amit Gal', email: 'amit.gal@landbright.test' }], landledgerRequestId: id, ref: 'REQ-41', app: 'linear', contractId: 'con_linear',
      text: expect.stringMatching(/^For Amit Gal: Landledger did not approve this seat's cost \(R-\d+: Amit Gal: No budget for Linear this quarter\), but Landbright granted the access under break-glass before the cost was decided\. Landflow can't revoke a grant/),
    });
    expect(rowsOf('Landledger unpaid seats')).toEqual([expect.objectContaining({ landledger_request_id: id, landbright_request_id: LB_ID, landbright_ref: 'REQ-41', app: 'linear', contract_id: 'con_linear', status: 'in_use' })]);
    // The reconcile leaves an open task alone.
    fake.state.requests.get(id).createdAt = new Date().toISOString();
    lbRequest({ ...breakGlass, annotations: { 'landflow.seat_cost': annotations()[0], 'landflow.seat_revoke': task } });
    lbCalls.length = 0;
    const hour = await run(workflow, 'Every hour', [{ scheduledAt: '2026-11-15T11:00:00.000Z' }]);
    expect(hour.out('Plan the reconcile')).toHaveLength(0);

    // A person revokes the grant in Landbright: the task closes and the seat stops counting.
    lbRequest({ ...breakGlass, grant: { id: 'grant-1', status: 'revoked', closedAt: '2026-11-15T12:00:00.000Z' }, annotations: { 'landflow.seat_revoke': task } });
    const revoked = await run(workflow, 'Landbright events', [lbEvent('grant.revoked', { requestId: LB_ID })]);
    expect(revoked.out('What the seat needs')[0].json).toMatchObject({ action: 'close' });
    expect(annotations().at(-1)).toMatchObject({ status: 'done', landledgerRequestId: id, endedAt: '2026-11-15T12:00:00.000Z' });
    expect(rowsOf('Landledger unpaid seats')).toEqual([expect.objectContaining({ landledger_request_id: id, status: 'revoked', ended_at: '2026-11-15T12:00:00.000Z' })]);
  });

  it('review 16: an extension that ends before the renewal rides on the first request\'s seat: linked, noted, and its gate settled at once citing that request', async () => {
    const workflow = await installSeat(true);
    const first = await seatInUse(workflow, '2026-11-22T09:00:00.000Z');
    lbRequest(extension);
    lbCalls.length = 0;
    const before = createdPosts().length;
    const ext = await run(workflow, 'Landbright events', [lbEvent('request.created', { ref: 'REQ-43', costs: ['linear'], waitsOn: 'Landledger' }, LB_ID_3)]);
    expect(ext.record.status).toBe('success');
    expect(ext.out('Extension or new seat?')[0].json).toMatchObject({ route: 0, rides: true, landledgerRequestId: first, newEnd: '2026-11-29', renewal: '2027-01-01', settleNow: true });
    expect(createdPosts()).toHaveLength(before);
    expect(rowsOf('Landledger seat requests')).toContainEqual(expect.objectContaining({ landbright_request_id: LB_ID_3, landbright_ref: 'REQ-43', landledger_request_id: first }));
    expect(annotations().at(-1)).toMatchObject({ status: 'cost_rides', landledgerRequestId: first, firstRequest: 'REQ-41', text: expect.stringContaining("This extension rides on REQ-41's seat") });
    expect(settles()).toEqual([expect.objectContaining({ path: `/api/v1/requests/${LB_ID_3}/steps/0/settle`, body: { outcome: 'approve', reference: { system: 'Landledger', id: first, url: `http://localhost:4811/requests/${first}` } } })]);
    expect(ext.out('Extension settled?')[0].json).toMatchObject({ settled: true });
    expect(lbRequests.get(LB_ID_3)).toMatchObject({ currentStep: 1, waitingOnSystem: null });
  });

  it('review 16: an extension past the contract\'s renewal gets a seat request of its own; one approved after its grant ended gets a new grant, and a seat request for it', async () => {
    const workflow = await installSeat();
    const first = await seatInUse(workflow, '2026-12-28T09:00:00.000Z');
    lbRequest(extension);
    const past = await run(workflow, 'Landbright events', [lbEvent('request.created', {}, LB_ID_3)]);
    expect(past.out('Extension or new seat?')[0].json).toMatchObject({ route: 1, rides: false, why: "the new end (2027-01-04) is on or after the contract's renewal (2027-01-01)" });
    const own = [...fake.state.requests.keys()].at(-1)!;
    expect(own).not.toBe(first);
    expect(createdPosts().at(-1)!.body).toMatchObject({ idempotencyKey: 'landbright-REQ-43', related: [{ type: 'landbright_request', id: 'REQ-43' }], note: expect.stringContaining("(an extension of REQ-41) takes a Linear Business seat: 2 left on the contract. It needs a seat of its own: the new end (2027-01-04) is on or after the contract's renewal (2027-01-01).") });
    expect(rowsOf('Landledger seat requests')).toContainEqual(expect.objectContaining({ landbright_request_id: LB_ID_3, landledger_request_id: own }));
  });

  it('review 16: an extension that rode, approved after its grant ended, gets a seat request of its own when the new grant starts, marked used once approved', async () => {
    const workflow = await installSeat();
    const first = await seatInUse(workflow, '2026-11-22T09:00:00.000Z');
    lbRequest(extension);
    await run(workflow, 'Landbright events', [lbEvent('request.created', {}, LB_ID_3)]);
    expect(rowsOf('Landledger seat requests')).toContainEqual(expect.objectContaining({ landbright_request_id: LB_ID_3, landledger_request_id: first }));
    // The grant ends before Landbright's approvers decide the extension: its seat goes back.
    lbRequest({ status: 'approved', currentStep: 1, waitingOnSystem: null, grant: { id: 'grant-1', status: 'expired' } });
    await run(workflow, 'Landbright events', [lbEvent('grant.expired', { requestId: LB_ID })]);
    expect(fake.state.requests.get(first).seat.status).toBe('released');
    // Approved now, the extension gets a new grant (grant-2): it can't ride on a seat that went back.
    const before = createdPosts().length;
    lbRequest({ ...extension, status: 'approved', currentStep: 1, waitingOnSystem: null, grant: { id: 'grant-2', status: 'active' } });
    const granted = await run(workflow, 'Landbright events', [lbEvent('grant.activated', { requestId: LB_ID_3 })]);
    expect(granted.out('What the seat needs')[0].json).toMatchObject({ action: 'raise', why: "REQ-43 was approved after REQ-41's grant ended: its new grant needs a seat of its own (R-1 is REQ-41's)" });
    expect(createdPosts()).toHaveLength(before + 1);
    expect(createdPosts().at(-1)!.body).toMatchObject({ idempotencyKey: 'landbright-REQ-43', origin: { type: 'landflow_run' }, related: [{ type: 'landbright_request', id: 'REQ-43' }] });
    const own = [...fake.state.requests.keys()].at(-1)!;
    expect(annotations().at(-1)).toMatchObject({ status: 'cost_asked', landledgerRequestId: own, text: expect.stringContaining('after Landbright gave this extension a new grant (its grant had ended)') });
    await costDecided(own, 'approve');
    const approved = await run(workflow, 'Landledger events', [llDecided(own, 'approved')]);
    expect(approved.out('What Landbright needs')[0].json).toMatchObject({ route: 1 });
    expect(fake.state.requests.get(own)).toMatchObject({ status: 'applied', seat: { status: 'applied' }, appliedNote: 'Granted in Landbright as REQ-43 (an extension approved after its grant ended); the cost was approved after' });
  });

  it('a Landbright event for a request it never raised a seat for stops at the table', async () => {
    const workflow = await installSeat();
    lbRequest({ status: 'denied' });
    const { ran } = await run(workflow, 'Landbright events', [lbEvent('request.decided', { outcome: 'denied' })]);
    expect(ran('Read the access request')).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });
});

describe('Landledger: draft variance notes', () => {
  // ---- Ollama, as the Ollama Chat Model node calls it (/api/chat): each reply comes from `reply`, every call is recorded.
  const ollamaCalls: Array<{ model: string; system: string; prompt: string }> = [];
  let reply: (prompt: string, call: number) => string = () => '';
  let ollamaUrl = '';
  const ollama = createServer(async (req, res) => {
    const body = JSON.parse(await readBody(req)) as { model: string; stream?: boolean; messages: Array<{ role: string; content: string }> };
    const prompt = body.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
    ollamaCalls.push({ model: body.model, system: body.messages.find((m) => m.role === 'system')?.content ?? '', prompt });
    const content = reply(prompt, ollamaCalls.length);
    const done = { model: body.model, done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 50 };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.end(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content }, done: false })}\n${JSON.stringify({ ...done, message: { role: 'assistant', content: '' } })}\n`);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ...done, message: { role: 'assistant', content } }));
  });
  /** A good draft for the note in the prompt: its actual and its variance to budget, cited exactly. */
  const good = (prompt: string) => {
    const center = /Cost center: (\S+)/.exec(prompt)![1];
    const f = NOTE_FIGURES.find((x) => x.costCenter === center)!;
    return '```json\n' + JSON.stringify({ text: `${center} cost ${Number(f.actual).toFixed(2)}, ${Number(f.varianceBudget).toFixed(2)} against its budget.`, cites: [{ figure: 'actual', amount: Number(f.actual).toFixed(2) }, { figure: 'variance_budget', amount: Number(f.varianceBudget).toFixed(2) }] }) + '\n```';
  };
  const wrong = (prompt: string) => JSON.stringify({ text: `${/Cost center: (\S+)/.exec(prompt)![1]} cost about 1300 this month.`, cites: [{ figure: 'actual', amount: '1300.00' }] });
  const requested = (sha = SNAPSHOT_SHA): JsonObject => ({
    type: 'notes.draft_requested', id: 'evt_notes', timestamp: '2026-11-15T08:00:00.000Z', month: NOTES_MONTH, snapshotSha256: sha, needed: NOTE_FIGURES,
    draftUrl: `${fake.url}/api/notes/${NOTES_MONTH}/drafts`, url: `http://localhost:4811/close/${NOTES_MONTH}`, requestId: null, kind: null, costCenter: null,
  });
  async function installNotes(model = 'qwen3-coder:30b', url = ollamaUrl) {
    const workflow = await install('landledger-variance-notes.json');
    const settings = workflow.nodes.find((n) => n.name === 'Settings')!;
    settings.parameters.codeEach = String(settings.parameters.codeEach)
      .replace("const OLLAMA_URL = 'http://host.docker.internal:11434';", `const OLLAMA_URL = '${url}';`)
      .replace("const MODEL = 'qwen3-coder:30b';", `const MODEL = '${model}';`);
    store.saveWorkflow(workflow);
    return store.getWorkflow(workflow.id)!;
  }
  const drafts = () => fake.requests.filter((r) => r.method === 'POST' && r.path === `/api/notes/${NOTES_MONTH}/drafts`);

  beforeAll(async () => {
    await new Promise<void>((resolve) => ollama.listen(0, '127.0.0.1', resolve));
    ollamaUrl = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}`;
    slots.landledgerNotes = credentials.create({ name: 'Landledger notes (test)', type: 'landledger.landledgerNotesKey', data: { baseUrl: fake.url, apiKey: NOTES_KEY } }).id;
  });
  afterAll(() => new Promise((resolve) => ollama.close(resolve)));
  beforeEach(() => {
    ollamaCalls.length = 0;
    reply = good;
    const table = dataTables().findTable('Landledger note drafts');
    if (table) dataTables().deleteRows(table.id, { type: 'and', conditions: [{ column: 'id', operator: 'isNotEmpty', value: '' }] });
  });

  it('drafts one note per cost center from the frozen snapshot with the local model, and submits each with the notes key', async () => {
    const workflow = await installNotes();
    const { record } = await run(workflow, 'Notes requested', [requested()]);
    expect(record.status).toBe('success');
    expect(fake.requests.find((r) => r.path === `/api/close/${NOTES_MONTH}/snapshot`)!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(fake.requests.find((r) => r.path === `/api/notes/${NOTES_MONTH}/figures`)!.headers.authorization).toBe(`Bearer ${NOTES_KEY}`);
    expect(ollamaCalls.map((c) => c.model)).toEqual(['qwen3-coder:30b', 'qwen3-coder:30b']);
    expect(ollamaCalls[1].system).toMatch(/Use only the figures listed under FIGURES/);
    expect(ollamaCalls[1].prompt).toContain('Cost center: ENG-AGENTS (Engineering agents)');
    expect(ollamaCalls[1].prompt).toContain('- {"figure":"variance_budget","amount":"-799.50"}: actual minus budget: under budget');
    expect(ollamaCalls[1].prompt).toContain('- {"figure":"driver_model","key":"claude-sonnet-5-5","amount":"150.25"}: Claude Sonnet 5.5 (model), its change on the month before: it cost more');
    expect(drafts().map((r) => r.headers.authorization)).toEqual([`Bearer ${NOTES_KEY}`, `Bearer ${NOTES_KEY}`]);
    expect(drafts()[1].body).toMatchObject({
      costCenter: 'ENG-AGENTS',
      snapshotSha256: SNAPSHOT_SHA,
      text: 'ENG-AGENTS cost 1200.50, -799.50 against its budget.',
      cites: [{ figure: 'actual', amount: '1200.500000' }, { figure: 'variance_budget', amount: '-799.500000' }],
      agent: { id: `landflow:${workflow.id}`, name: 'Variance note drafter', system: 'landflow' },
      runId: record.executionId,
    });
    expect(drafts()[1].body.sponsor).toBeUndefined();
    expect(fake.state.notes.get(`${NOTES_MONTH}|TOTAL`).versions).toHaveLength(1);
    expect(rowsOf('Landledger note drafts').map((r) => [r.cost_center, r.outcome, r.attempt])).toEqual([['TOTAL', 'submitted', 1], ['ENG-AGENTS', 'submitted', 1]]);
  });

  it('redrafts once with Landledger’s refusal when a cited figure does not match, then submits', async () => {
    const workflow = await installNotes();
    reply = (prompt, call) => (call === 2 ? wrong(prompt) : good(prompt));
    const { record } = await run(workflow, 'Notes requested', [requested()]);
    expect(record.status).toBe('success');
    expect(ollamaCalls).toHaveLength(3);
    expect(ollamaCalls[2].prompt).toContain('Landledger refused your previous draft: Landledger API error 422: A cited figure does not match the snapshot (mismatches: [{"figure":"actual","key":null,"cited":"1300.000000","snapshot":"1200.500000"}])');
    expect(ollamaCalls[2].prompt).toContain('Cost center: ENG-AGENTS');
    expect(drafts()).toHaveLength(3);
    expect(fake.state.notes.get(`${NOTES_MONTH}|ENG-AGENTS`).versions).toHaveLength(1);
    expect(rowsOf('Landledger note drafts').map((r) => [r.cost_center, r.outcome, r.attempt])).toEqual(expect.arrayContaining([['TOTAL', 'submitted', 1], ['ENG-AGENTS', 'submitted', 2]]));
  });

  it('gives up after one redraft and leaves the note to Landledger’s template; nothing else is retried', async () => {
    const workflow = await installNotes();
    reply = (prompt) => (prompt.includes('ENG-AGENTS') ? wrong(prompt) : good(prompt));
    const { record } = await run(workflow, 'Notes requested', [requested()]);
    expect(record.status).toBe('success');
    expect(ollamaCalls.filter((c) => c.prompt.includes('Cost center: ENG-AGENTS'))).toHaveLength(2);
    expect(fake.state.notes.has(`${NOTES_MONTH}|ENG-AGENTS`)).toBe(false);
    const rows = rowsOf('Landledger note drafts');
    expect(rows.find((r) => r.cost_center === 'ENG-AGENTS')).toMatchObject({ outcome: 'gave_up', attempt: 2, refusal: expect.stringMatching(/422: A cited figure does not match/) });
    expect(rows.find((r) => r.cost_center === 'TOTAL')).toMatchObject({ outcome: 'submitted', attempt: 1 });
  });

  it('the rounding nit: a half cent is cited as Landledger rounds it (half away from zero), which Landledger accepts', async () => {
    const workflow = await installNotes();
    // 1.005 is 1.00499999… as a float: toFixed(2) said 1.00, which Landledger refuses as a mismatch.
    reply = (prompt) => {
      const center = /Cost center: (\S+)/.exec(prompt)![1];
      const f = NOTE_FIGURES.find((x) => x.costCenter === center)!;
      const cites = [{ figure: 'actual', amount: Number(f.actual).toFixed(2) }, ...(center === 'ENG-AGENTS' ? [{ figure: 'driver_service', key: 'landledger-api', amount: /"key":"landledger-api","amount":"([^"]+)"/.exec(prompt)![1] }] : [])];
      return JSON.stringify({ text: `${center} cost ${cites[0].amount} this month.`, cites });
    };
    const { record } = await run(workflow, 'Notes requested', [requested()]);
    expect(record.status).toBe('success');
    expect(ollamaCalls[1].prompt).toContain('- {"figure":"driver_service","key":"landledger-api","amount":"1.01"}: landledger-api (service), its change on the month before: it cost more');
    expect(drafts()).toHaveLength(2);
    expect(rowsOf('Landledger note drafts').map((r) => [r.cost_center, r.outcome, r.attempt])).toEqual([['TOTAL', 'submitted', 1], ['ENG-AGENTS', 'submitted', 1]]);
  });

  it('drafts nothing for an event whose snapshot is no longer the month’s', async () => {
    const workflow = await installNotes();
    const { record } = await run(workflow, 'Notes requested', [requested('d'.repeat(64))]);
    expect(record.status).toBe('success');
    expect(ollamaCalls).toHaveLength(0);
    expect(drafts()).toHaveLength(0);
  });

  it('the model is a setting', async () => {
    const workflow = await installNotes('qwen3.8:latest');
    await run(workflow, 'Notes requested', [requested()]);
    expect(new Set(ollamaCalls.map((c) => c.model))).toEqual(new Set(['qwen3.8:latest']));
  });

  // LANDFLOW_INTEGRATION=ollama: the real local model (OLLAMA_URL, default 127.0.0.1:11434, qwen3-coder:30b) drafts
  // against the fake Landledger, which checks every cite to the cent. Each note ends submitted or given up, never lost.
  it.skipIf(!process.env.LANDFLOW_INTEGRATION?.split(',').includes('ollama'))('drafts with the real local model', async () => {
    const workflow = await installNotes('qwen3-coder:30b', process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434');
    const { record } = await run(workflow, 'Notes requested', [requested()]);
    expect(record.status).toBe('success');
    const rows = rowsOf('Landledger note drafts');
    expect(rows.map((r) => r.cost_center).sort()).toEqual(['ENG-AGENTS', 'TOTAL']);
    for (const r of rows) expect(['submitted', 'gave_up']).toContain(r.outcome);
    expect(rows.some((r) => r.outcome === 'submitted')).toBe(true);
    for (const d of drafts()) console.log(`[ollama] ${String(d.body.costCenter)}: ${String(d.body.text)} ${JSON.stringify(d.body.cites)}`);
    console.log(`[ollama] ${JSON.stringify(rows.map((r) => [r.cost_center, r.outcome, r.attempt, r.refusal]))}`);
  }, 600_000);
});

describe('Landledger: incident cost to the room', () => {
  let landfall: FakeLandfall;
  beforeAll(async () => {
    landfall = await startFakeLandfall();
    slots.landfall = credentials.create({ name: 'Landfall (test)', type: 'landfall.landfallApi', data: { baseUrl: landfall.url, orgSlug: LANDFALL_SEED.orgSlug, apiKey: LANDFALL_SEED.apiKey } }).id;
  });
  afterAll(() => landfall.server?.close());
  /** A room for checkout that was open an hour and a half, with landflow-host attached, then resolved. */
  function resolvedRoom(alertEntity: JsonObject | null = { kind: 'service', id: 'checkout' }) {
    const incident = landfall.seed({ title: 'Checkout errors', severity: 'sev2', alertEntity: alertEntity as never, createdAt: '2026-11-14T08:00:00.000Z' });
    landfall.append(incident, 'context.attached', { kind: 'service', id: 'landflow-host', label: 'Landflow host' }, 'system');
    landfall.append(incident, 'context.attached', { kind: 'pod', id: 'checkout-7d9' }, 'system');
    const end = landfall.append(incident, 'status.changed', { status: 'resolved', from: 'open' });
    end.occurredAt = '2026-11-14T09:30:00.000Z';
    const { events: _events, connectionId: _c, dedupKey: _d, ...view } = incident as unknown as JsonObject;
    return { incident, item: { event: 'incident.ended', incident: view } };
  }

  it('posts the estimated cost of the room’s services over its window as a note, with a link to Explore', async () => {
    const workflow = await install('landledger-incident-cost.json');
    const { incident, item } = resolvedRoom();
    const { record, out } = await run(workflow, 'Room ended', [item]);
    expect(record.status).toBe('success');
    const window = fake.requests.find((r) => r.path === '/api/cost/window')!;
    expect(window.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(window.query).toEqual({ services: 'checkout,landflow-host', from: '2026-11-14T08:00:00.000Z', to: '2026-11-14T09:30:00.000Z' });
    const note = incident.events.at(-1)!;
    expect(note.type).toBe('chat.message');
    expect(String(note.payload.text)).toBe(
      [
        "Pro-rated spend of these services during the incident (estimated), not the incident's extra cost: $53.25 (USD), 2026-11-14 08:00 to 2026-11-14 09:30 UTC (1 h 30 min).",
        '- checkout: $41.25',
        '- landflow-host: $12.00',
        "Estimated: each day's cost of these services in Landledger, by the share of the day inside the incident's window: what they cost while it was open, not what the incident added. Not an invoiced figure.",
        'Explore in Landledger: http://localhost:4811/explore?by=service&month=2026-11&filter=service%3Acheckout%2Cservice%3Alandflow-host',
        "Posted by Landflow as a room note: it can't write a postmortem section.",
      ].join('\n'),
    );
    expect(out('Write the note')[0].json).toMatchObject({ total: '53.250000' });
  });

  it('review 18: no matching services says the cost is unknown, never $0.00', async () => {
    const workflow = await install('landledger-incident-cost.json');
    const incident = landfall.seed({ title: 'Ghost errors', alertEntity: { kind: 'service', id: 'ghost' } as never, createdAt: '2026-11-14T08:00:00.000Z' });
    landfall.append(incident, 'status.changed', { status: 'resolved', from: 'open' }).occurredAt = '2026-11-14T09:30:00.000Z';
    const { events: _events, connectionId: _c, dedupKey: _d, ...view } = incident as unknown as JsonObject;
    const { record, out } = await run(workflow, 'Room ended', [{ event: 'incident.ended', incident: view }]);
    expect(record.status).toBe('success');
    const text = String(incident.events.at(-1)!.payload.text);
    expect(text.split('\n').slice(0, 2)).toEqual(['No matching services: cost unknown. Landledger has no cost under ghost, 2026-11-14 08:00 to 2026-11-14 09:30 UTC (1 h 30 min).', '- ghost: no cost in Landledger under this name']);
    expect(text).not.toContain('$0.00');
    expect(out('Write the note')[0].json).toMatchObject({ total: null, known: 0 });
  });

  it('review 18: a room open longer than 31 days is asked in parts and added up, and the share on the 1st of a month is said to be possibly invoice lines', async () => {
    const workflow = await install('landledger-incident-cost.json');
    const incident = landfall.seed({ title: 'Slow checkout', alertEntity: { kind: 'service', id: 'checkout' } as never, createdAt: '2026-10-20T00:00:00.000Z' });
    landfall.append(incident, 'status.changed', { status: 'resolved', from: 'open' }).occurredAt = '2026-12-02T00:00:00.000Z';
    const { events: _events, connectionId: _c, dedupKey: _d, ...view } = incident as unknown as JsonObject;
    const { record, out } = await run(workflow, 'Room ended', [{ event: 'incident.ended', incident: view }]);
    expect(record.status).toBe('success');
    expect(fake.requests.filter((r) => r.path === '/api/cost/window').map((r) => [r.query.from, r.query.to])).toEqual([
      ['2026-10-20T00:00:00.000Z', '2026-11-20T00:00:00.000Z'],
      ['2026-11-20T00:00:00.000Z', '2026-12-02T00:00:00.000Z'],
    ]);
    expect(out('Write the note')[0].json).toMatchObject({ total: '82.500000', chunks: 2 });
    const lines = String(incident.events.at(-1)!.payload.text).split('\n');
    expect(lines[0]).toBe("Pro-rated spend of these services during the incident (estimated), not the incident's extra cost: $82.50 (USD), 2026-10-20 00:00 to 2026-12-02 00:00 UTC (43 d 0 h).");
    // The fake spreads $41.25 over each part's days: 31 days ($1.330645 a day, the first $1.330660), then 12 ($3.437500 a day).
    expect(lines).toContain("Of this, $4.77 falls on 2026-11-01 and 2026-12-01: Landledger charges invoice lines that have no daily estimate on the 1st of the month, so those days may hold part of a month's invoice rather than spend during the incident.");
    expect(lines).toContain('The window is longer than the 31 days Landledger answers at a time: it was asked in 2 parts and added up.');
  });

  it('a room that names no service posts nothing and asks Landledger nothing', async () => {
    const workflow = await install('landledger-incident-cost.json');
    const incident = landfall.seed({ title: 'Something odd', alertEntity: null, createdAt: '2026-11-14T08:00:00.000Z' });
    landfall.append(incident, 'status.changed', { status: 'resolved', from: 'open' });
    const { events: _events, ...view } = incident as unknown as JsonObject;
    const { record, ran } = await run(workflow, 'Room ended', [{ event: 'incident.ended', incident: view }]);
    expect(record.status).toBe('success');
    expect(ran('No service named: nothing to cost')).toBe(true);
    expect(fake.requests.some((r) => r.path === '/api/cost/window')).toBe(false);
    expect(incident.events.at(-1)!.type).toBe('status.changed');
  });
});
