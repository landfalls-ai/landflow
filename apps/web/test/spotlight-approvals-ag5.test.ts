/**
 * AG23 (wave ag5): Spotlight approves its test runs' tool calls to given destinations. The person's decision of 2026-11-18:
 * "We can let Spotlight approve automatically when he's fixing." The run route takes `approvals: 'spotlight'` only for an editor
 * test run; the Run an Agent node then lets Spotlight decide a call that asks first (the agent runtime): it runs when every
 * destination was given, else it waits for the person (or is refused where the run can't wait), never runs. The real messaging
 * plugin sends through a fake SMTP; the agent's model is scripted on the fake Ollama.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { toToolName, type Workflow, type WorkflowNode } from '@landflow/engine';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeSmtp } from '../../../plugins/messaging/test/fake-smtp';

vi.setConfig({ testTimeout: 60_000 });

const PASSWORD = 'pw-ag23-smtp-made-up';
const smtp = await startFakeSmtp({ auth: { user: 'mail', password: PASSWORD }, authMethods: ['PLAIN'] });
const dataDir = mkdtempSync(join(tmpdir(), 'landflow-ag23-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', OUTBOUND_ALLOW: 'local' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { store } = await import('@/lib/server/store');
const { agentStore } = await import('@/lib/server/agents/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { smokeTest } = await import('@/lib/server/agents/smoke-test');
const { approvedByLine } = await import('@/lib/shared/fix-autonomy');
const { singleton } = await import('@/lib/server/singleton');
const { enableTestAuth, TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const runRoute = await import('@/app/api/workflows/[id]/run/route');
const updateRoute = await import('@/app/api/workflows/[id]/test-update/route');

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(messaging);

type Body = { model: string; messages: Array<{ role: string; content: string }> };
let script: (turn: number, body: Body) => FakeReply = () => ({ text: 'ok' });
const turns = new Map<string, number>();
const fake = await startFakeModels({
  reply: (_provider, body: Body) => {
    const n = (turns.get(body.model) ?? 0) + 1;
    turns.set(body.model, n);
    return script(n, { ...body });
  },
});
afterAll(async () => {
  await fake.close();
  await smtp.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const mail = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: smtp.port, secure: false, disableStartTls: true, user: 'mail', password: PASSWORD } });
const baseUrl = fake.url.replace(/\/v1$/, '');
const emailTool = (to: string, requireApproval = true) => ({
  id: 't1',
  type: 'node' as const,
  name: 'Send Email',
  description: 'Send an email',
  nodeType: 'messaging.emailSend',
  credentials: { smtp: { id: mail.id, name: mail.name } },
  parameters: { fromEmail: 'landflow@landflow.test', toEmail: to, subject: 'Triage', emailFormat: 'text', text: 'Looked at it.' },
  requireApproval,
});
const mailer = (name: string, to: string) => {
  const agent = agentStore.create({ name, instructions: 'You email on-call.', model: { provider: 'ollama', model: `m-${name}`, baseUrl }, tools: [emailTool(to)] });
  agentStore.publish(agent.id);
  return agent;
};
const fixed = mailer('Fixed mailer', 'oncall@landflow.test');
const loose = mailer('Loose mailer', "={{ $fromAI('to', 'who gets it', 'string') }}");

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
let n = 0;
function flow(agentId: string, extra: WorkflowNode[] = []): Workflow {
  const wf: Workflow = {
    id: `wf_ag23_${++n}`,
    name: 'ag23',
    nodes: [node('Start', 'core.webhook', { path: `ag23-${n}` }), node('Agent', 'core.messageAgent', { agentId, message: 'Email oncall about the alert' }), ...extra],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  return wf;
}

type Handler = (request: Request, ctx?: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function post(route: unknown, id: string, body: unknown) {
  const response = await (route as Handler)(new Request(`http://localhost:3000/api/workflows/${id}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
  return { status: response.status, text: await response.text() };
}
/** The run's final `result` event from the SSE stream. */
const resultOf = (text: string) => {
  const m = /event: result\ndata: (.*)\n/.exec(text);
  return m ? (JSON.parse(m[1]) as { executionId: string; status: string; error?: { message: string } }) : undefined;
};
const SPOTLIGHT = { approvals: 'spotlight', sessionId: 'test_ag23', destinations: [] as string[] };
const sendCall = (args: Record<string, unknown> = { subject: 'Triage' }) => ({ toolCalls: [{ id: 'c_send', name: toToolName('Send Email'), arguments: args }] });
const entries = (executionId: string) => agentStore.listSessions?.().filter((s) => s.execution?.executionId === executionId) ?? [];

beforeEach(() => {
  smtp.mails.length = 0;
  turns.clear();
  enableTestAuth(TEST_OWNER);
});

describe('the run body', () => {
  it('a manual editor run with approvals: spotlight sends the call to a destination the agent gave, and says who approved', async () => {
    script = (t) => (t === 1 ? sendCall() : { text: 'Emailed on-call.' });
    const wf = flow(fixed.id);
    const { status, text } = await post(runRoute.POST, wf.id, SPOTLIGHT);
    expect(status).toBe(200);
    const result = resultOf(text)!;
    expect(result.error?.message ?? result.status).toBe('success');
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0].to).toEqual(['oncall@landflow.test']);
    const record = (await store.loadExecution(result.executionId))!;
    expect(record.spotlightApprovals).toMatchObject({ sessionId: 'test_ag23', userId: TEST_OWNER.id });
    const json = record.runData.Agent?.at(-1)?.outputs?.[0]?.[0]?.json as { steps: Array<{ tool: string; status: string; approvedBy?: string }>; sessionId: string };
    expect(json.steps).toEqual([expect.objectContaining({ tool: toToolName('Send Email'), status: 'success', approvedBy: 'Approved by Spotlight (autonomous fix session)' })]);
    expect(json.steps[0].approvedBy).toBe(approvedByLine({ kind: 'spotlight', userId: TEST_OWNER.id, sessionId: 'test_ag23' }, true));
    const entry = agentStore.getSession(json.sessionId)!.timeline.find((e) => e.type === 'tool');
    expect(entry).toMatchObject({ type: 'tool', status: 'success', by: { kind: 'spotlight', userId: TEST_OWNER.id, sessionId: 'test_ag23' } });
  });

  it('a call to a destination nobody gave is not run: it waits for the person', async () => {
    script = (t) => (t === 1 ? sendCall({ to: 'x@elsewhere.test', subject: 'Triage' }) : { text: 'Left for you.' });
    const wf = flow(loose.id);
    const { text } = await post(runRoute.POST, wf.id, SPOTLIGHT);
    const result = resultOf(text)!;
    expect(result.status).toBe('waiting');
    expect(smtp.mails).toHaveLength(0);
    const record = (await store.loadExecution(result.executionId))!;
    const approval = record.wait?.data?.approval as { calls: Array<{ tool: string; input: Record<string, unknown> }> };
    expect(approval.calls).toEqual([expect.objectContaining({ tool: 'Send Email', input: expect.objectContaining({ to: 'x@elsewhere.test' }) })]);
  });

  it('the same call runs when the person gave the destination in the body', async () => {
    script = (t) => (t === 1 ? sendCall({ to: 'X@Elsewhere.test', subject: 'Triage' }) : { text: 'Emailed.' });
    const wf = flow(loose.id);
    const result = resultOf((await post(runRoute.POST, wf.id, { ...SPOTLIGHT, destinations: ['x@elsewhere.test'] })).text)!;
    expect(result.status).toBe('success');
    expect(smtp.mails).toHaveLength(1);
    expect(smtp.mails[0].to).toEqual(['X@Elsewhere.test']); // as the model gave it: never rewritten
  });

  it('AG22 and AG23 agree: a brand-new draft’s own addresses are not given, a published flow’s are', async () => {
    const { setPublication } = await import('@/lib/server/publications');
    const own = [node('Mail', 'messaging.emailSend', { toEmail: 'ops@landflow.test', subject: 's', text: 't' })];
    script = (t) => (t === 1 ? sendCall({ to: 'ops@landflow.test', subject: 'Triage' }) : { text: 'Done.' });
    const draft = flow(loose.id, own);
    expect(resultOf((await post(runRoute.POST, draft.id, SPOTLIGHT)).text)!.status).toBe('waiting'); // never published: the builder's own address is not given
    expect(smtp.mails).toHaveLength(0);
    turns.clear();
    const live = flow(loose.id, own);
    setPublication(live.id, store.listVersions?.(live.id)?.[0]?.id ?? 'v1');
    expect(resultOf((await post(runRoute.POST, live.id, SPOTLIGHT)).text)!.status).toBe('success'); // published: the flow's own address counts
    expect(smtp.mails).toHaveLength(1);
  });

  it('where the run cannot wait the call is refused with the line, never run', async () => {
    // A model wired on the node: no decision can wait there, so the call that nobody gave is refused.
    const { approvedByLine: line } = await import('@/lib/shared/fix-autonomy');
    const { runAgent, newSession } = await import('@/lib/server/agents/runtime');
    script = (t) => (t === 1 ? sendCall({ to: 'x@elsewhere.test', subject: 'Triage' }) : { text: 'Not sent.' });
    const session = newSession(loose, { source: 'workflow', userId: 'workflow:x', version: 'draft' });
    const by = { kind: 'spotlight' as const, userId: TEST_OWNER.id, sessionId: 'test_ag23' };
    const result = await runAgent({ agent: loose, session, message: 'go', approvals: 'spotlight', spotlight: { by, given: ['oncall@landflow.test'], canWait: false } });
    expect(result.reason).toBe('completed');
    expect(smtp.mails).toHaveLength(0);
    const entry = session.timeline.find((e) => e.type === 'tool');
    expect(entry).toMatchObject({ status: 'denied', error: line(by, false), decidedLine: line(by, false) });
    expect(line(by, false)).toBe('Left for you by Spotlight: a destination nobody gave');
  });

  it('without the field nothing changes: the call is refused as before', async () => {
    script = (t) => (t === 1 ? sendCall() : { text: 'Not sent.' });
    const wf = flow(fixed.id);
    const result = resultOf((await post(runRoute.POST, wf.id, {})).text)!;
    expect(result.status).toBe('success');
    expect(smtp.mails).toHaveLength(0);
    const record = (await store.loadExecution(result.executionId))!;
    const json = record.runData.Agent?.at(-1)?.outputs?.[0]?.[0]?.json as { steps: Array<{ status: string; error?: string }> };
    expect(json.steps[0]).toMatchObject({ status: 'denied', error: expect.stringContaining('needs a person') });
  });

  it('is refused (and nothing sent) for a rerun, an API key, a viewer, the test-update run and a field without a session', async () => {
    script = (t) => (t === 1 ? sendCall() : { text: 'x' });
    const wf = flow(fixed.id);
    const rerun = await post(runRoute.POST, wf.id, { ...SPOTLIGHT, rerun: { executionId: 'ex_nothing', scope: 'all' } });
    expect(rerun.status).toBe(400);
    expect(rerun.text).toContain('Spotlight’s approvals apply only to an editor test run');
    const noSession = await post(runRoute.POST, wf.id, { approvals: 'spotlight' });
    expect(noSession.status).toBe(400);
    expect((await post(runRoute.POST, wf.id, { sessionId: 'x' })).status).toBe(400); // the other two fields alone carry nothing
    // An API key: the principal is `api-key`.
    const bypass = singleton<{ principal?: unknown }>('auth-test-bypass', () => ({}));
    bypass.principal = { user: TEST_OWNER, via: 'api-key', apiKey: { id: 'k1', scopes: ['admin'] } };
    const key = await post(runRoute.POST, wf.id, SPOTLIGHT);
    expect(key.status).toBe(400);
    expect(key.text).toContain('Spotlight’s approvals apply only to an editor test run');
    // A viewer has no run access at all.
    enableTestAuth({ ...TEST_OWNER, id: 'usr_viewer', email: 'viewer@landflow.test', role: 'viewer' });
    const viewer = await post(runRoute.POST, wf.id, SPOTLIGHT);
    expect([400, 403, 404]).toContain(viewer.status);
    enableTestAuth(TEST_OWNER);
    // The test-update run of the production version never takes it.
    const update = await (updateRoute.POST as Handler)(new Request(`http://localhost:3000/api/workflows/${wf.id}/test-update`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agents: [fixed.id], ...SPOTLIGHT }) }), { params: Promise.resolve({ id: wf.id }) });
    expect(update.status).toBe(400);
    expect(smtp.mails).toHaveLength(0);
  });
});

describe('what Spotlight never approves', () => {
  it('a sub-agent’s call stays denied, also in the same run', async () => {
    const child = mailer('Child mailer', 'oncall@landflow.test');
    const parent = agentStore.create({ name: 'Parent', instructions: 'You delegate.', model: { provider: 'ollama', model: 'm-parent', baseUrl }, tools: [{ id: 'sa', type: 'agent', agentId: child.id }] });
    agentStore.publish(parent.id);
    script = (t, body) => {
      if (body.model === 'm-parent') return t === 1 ? { toolCalls: [{ id: 'c_ask', name: `ask_${child.name.toLowerCase().replace(/\W+/g, '_')}`, arguments: { task: 'email oncall', reason: 'needed' } }] } : { text: 'Delegated.' };
      return t === 1 ? sendCall() : { text: 'Could not send.' };
    };
    const wf = flow(parent.id);
    const result = resultOf((await post(runRoute.POST, wf.id, SPOTLIGHT)).text)!;
    expect(result.status).toBe('success');
    expect(smtp.mails).toHaveLength(0);
  });

  it('the smoke test (like the eval gate) keeps approvals denied', async () => {
    script = (t) => (t === 1 ? sendCall() : { text: 'x' });
    const smoke = await smokeTest(fixed.id, 'Email on-call');
    expect(smtp.mails).toHaveLength(0);
    expect(JSON.stringify(smoke)).toMatch(/approval|denied/);
  });
});

describe('destinations nobody gave (lesson 21)', () => {
  it('a recipient on a non-email write is never given by being configured: a WhatsApp or Twilio number, a SQL change', async () => {
    const { callDestinations, agentDestinations, spotlightVerdict } = await import('@/lib/server/agents/spotlight-approvals');
    const tool = (nodeType: string, parameters: Record<string, unknown>) => ({ id: 'x', type: 'node' as const, name: 'T', description: 'd', nodeType, parameters, requireApproval: true });
    const cases: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
      ['messaging.whatsappSend', { recipientPhoneNumber: "={{ $fromAI('n') }}", text: 'hi' }, { recipientPhoneNumber: '+15550000999', text: 'hi' }],
      ['messaging.twilioSend', { to: "={{ $fromAI('n') }}", body: 'hi' }, { to: '+15550000999', body: 'hi' }],
      ['databases.postgres', { operation: 'executeQuery', query: "={{ $fromAI('q') }}" }, { operation: 'executeQuery', query: 'DROP TABLE customers' }],
    ];
    for (const [type, configured, call] of cases) {
      const given = agentDestinations({ tools: [tool(type, configured)] });
      expect(given, type).toEqual([]);
      expect(spotlightVerdict(callDestinations(type, call), given), type).toBe('leave');
    }
    // A number the agent fixed is given.
    const fixedNumber = agentDestinations({ tools: [tool('messaging.whatsappSend', { recipientPhoneNumber: '+15550000111' })] });
    expect(spotlightVerdict(callDestinations('messaging.whatsappSend', { recipientPhoneNumber: '+15550000111' }), fixedNumber)).toBe('approve');
    expect(spotlightVerdict(callDestinations('messaging.whatsappSend', { recipientPhoneNumber: '+15550000999' }), fixedNumber)).toBe('leave');
    const standIn = callDestinations('databases.postgres', { operation: 'executeQuery', query: 'DROP TABLE customers' });
    expect(spotlightVerdict(standIn, standIn)).toBe('approve'); // named in the person's body destinations
  });

  it('a flow node of the same type and operation does not give a write that names no address (SQL, a webhook send)', async () => {
    const { callDestinations, flowDestinations, spotlightVerdict } = await import('@/lib/server/agents/spotlight-approvals');
    const wf = { nodes: [node('Q', 'databases.postgres', { operation: 'executeQuery', query: 'SELECT 1' }), node('D', 'messaging.discordSend', { operation: 'send', webhookUrl: 'https://discord.test/hook', text: 'hi' })] };
    const given = flowDestinations(wf);
    expect(given).not.toContain('databases.postgres executeQuery');
    for (const [type, call] of [['databases.postgres', { operation: 'executeQuery', query: 'DROP TABLE customers' }], ['messaging.discordSend', { operation: 'send', webhookUrl: 'https://other.test/hook', text: 'x' }]] as const) {
      expect(spotlightVerdict(callDestinations(type, call), given), type).toBe('leave');
    }
    // A flow's own sending node still gives its concrete address, and an HTTP step its host.
    const mailFlow = flowDestinations({ nodes: [node('M', 'messaging.emailSend', { toEmail: 'ops@landflow.test', subject: 's', text: 't' }), node('H', 'core.httpRequest', { method: 'POST', url: 'https://api.landflow.test/x' })] });
    expect(mailFlow).toContain('ops@landflow.test');
    expect(spotlightVerdict(['ops@landflow.test'], mailFlow)).toBe('approve');
    // Only the person's body destinations can name a stand-in-only call.
    const standIn = callDestinations('databases.postgres', { operation: 'executeQuery', query: 'DROP TABLE customers' });
    expect(spotlightVerdict(standIn, [...given, ...standIn])).toBe('approve');
  });

  it('no destination found never means approve: a GitHub commit, a Landfall declare, a Landledger cancel are left with nothing given', async () => {
    const { callDestinations, spotlightVerdict, spotlightDestinations } = await import('@/lib/server/agents/spotlight-approvals');
    const calls: Array<[string, Record<string, unknown>]> = [
      ['github.github', { resource: 'files', operation: 'commit', owner: 'o', repo: 'r', branch: 'main' }],
      ['landfall.landfall', { operation: 'declare' }],
      ['landledger.landledger', { operation: 'cancel' }],
    ];
    for (const [type, call] of calls) {
      const found = callDestinations(type, call);
      expect(found, type).toEqual([`${type} ${call.operation}`]);
      expect(spotlightVerdict(found, []), type).toBe('leave');
      // The person's own words naming the stand-in still give it.
      expect(spotlightVerdict(found, found), type).toBe('approve');
    }
    // A tool that reports no destination at all (or fails to) is left too.
    expect(await spotlightDestinations({ destinationsOf: async () => [] }, {}, undefined)).toEqual(['{{ … }}']);
    expect(spotlightVerdict(await spotlightDestinations({ destinationsOf: async () => [] }, {}, undefined), [])).toBe('leave');
    expect(spotlightVerdict(await spotlightDestinations({}, {}, undefined), ['x'])).toBe('leave');
    // An HTTP call to a given URL is still approved.
    const url = 'https://api.landflow.test/x';
    expect(spotlightVerdict(callDestinations('core.httpRequest', { method: 'POST', url }), [callDestinations('core.httpRequest', { url })[0]])).toBe('approve');
  });

  it('an asks-first workflow tool is left for the person, not run', async () => {
    const sub: Workflow = { id: 'wf_ag23_sub', name: 'Notify sub', nodes: [node('In', 'core.workflowTrigger', {})], connections: [] };
    store.saveWorkflow(sub);
    const agent = agentStore.create({ name: 'Flow caller', instructions: 'You call a flow.', model: { provider: 'ollama', model: 'm-flowcaller', baseUrl }, tools: [{ id: 'w1', type: 'workflow', name: 'Notify', description: 'Notify', workflowId: sub.id, requireApproval: true }] });
    agentStore.publish(agent.id);
    script = (t) => (t === 1 ? { toolCalls: [{ id: 'c_wf', name: toToolName('Notify'), arguments: {} }] } : { text: 'Left.' });
    const result = resultOf((await post(runRoute.POST, flow(agent.id).id, SPOTLIGHT)).text)!;
    expect(result.status).toBe('waiting');
  });
});
