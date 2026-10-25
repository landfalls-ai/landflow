/**
 * The Slack agent channel and Slack tool approvals, against a fake Slack Web API (./fake-ai-services) and the fake
 * OpenAI-compatible model: request signing (signing secret, timestamp skew), the Events API (url_verification,
 * mentions and DMs → the agent → a reply in the thread, retries, allow lists), Approve / Reject buttons for an
 * agent's tools and for an AI Agent node in a workflow (POST /api/slack/interactions), approvers and app checks.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { JsonObject } from '@landflow/protocol';
import type { AgentChannel } from '@/lib/shared/agents';
import { startFakeModels, startFakeSlack } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-slack-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { defineCredentialType, definePlugin } = await import('@landflow/sdk');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow } = await import('@/lib/server/runner');
const { agentStore } = await import('@/lib/server/agents/store');
const { APPROVE_ACTION, REJECT_ACTION, settleSlackTasks, slackSignature, verifySlackRequest } = await import('@/lib/server/slack');
const eventsRoute = await import('@/app/api/slack/events/[agentId]/[channelId]/route');
const interactionsRoute = await import('@/app/api/slack/interactions/route');
const { isPublicPath } = await import('@/lib/shared/auth-paths');

// The messaging plugin's Slack credential type (the plugin runs out of process in production).
const messaging = definePlugin({
  info: { id: 'messaging', name: 'Messaging', version: '1.0.0', language: 'typescript' },
  credentialTypes: [
    defineCredentialType({
      name: 'slackApi',
      displayName: 'Slack API',
      properties: [
        { name: 'accessToken', displayName: 'Access Token', type: 'string', required: true, typeOptions: { password: true } },
        { name: 'baseUrl', displayName: 'Base URL', type: 'string', default: 'https://slack.com/api' },
        { name: 'signingSecret', displayName: 'Signing Secret', type: 'string', default: '', typeOptions: { password: true } },
      ],
    }),
  ],
  nodes: [],
});
registry.registerBuiltin(corePlugin);
registry.registerBuiltin(messaging);

const SECRET = 'slack-signing-secret';
const TOKEN = 'xoxb-test-token';
const slack = await startFakeSlack({ token: TOKEN });
const models = await startFakeModels();
const slackApp = credentials.create({ name: 'Slack app', type: 'messaging.slackApi', data: { accessToken: TOKEN, baseUrl: slack.url, signingSecret: SECRET } });
const otherApp = credentials.create({ name: 'Other Slack app', type: 'messaging.slackApi', data: { accessToken: 'xoxb-other', baseUrl: slack.url, signingSecret: 'other-secret' } });
const openAi = credentials.create({ name: 'Fake OpenAI', type: 'core.openAiApi', data: { apiKey: 'sk-test', baseUrl: models.url } });
const slackRef = { id: slackApp.id, name: slackApp.name };
const openAiRef = { id: openAi.id, name: openAi.name };

afterAll(async () => {
  await settleSlackTasks();
  await slack.close();
  await models.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  slack.calls.length = 0;
});

/** Slack's signature headers for a body. */
function signed(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
  return { 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': slackSignature(secret, timestamp, body) };
}

let eventNumber = 0;
async function sendEvent(agentId: string, channelId: string, payload: JsonObject, options: { secret?: string; eventId?: string } = {}) {
  const body = JSON.stringify({ type: 'event_callback', event_id: options.eventId ?? `Ev${++eventNumber}`, team_id: 'T1', ...payload });
  const response = await eventsRoute.POST(
    new Request(`http://slack.test/api/slack/events/${agentId}/${channelId}`, { method: 'POST', headers: { 'content-type': 'application/json', ...signed(body, options.secret) }, body }),
    { params: Promise.resolve({ agentId, channelId }) },
  );
  await settleSlackTasks();
  return response;
}

/** Click a button of a message the fake Slack received. */
async function click(message: { body: { channel: string; blocks?: JsonObject[] }; ts?: string }, action: string, user: string, secret = SECRET) {
  const ts = message.ts!;
  const actions = (message.body.blocks ?? []).find((b) => b.type === 'actions') as { elements: Array<{ action_id: string; value: string }> };
  const value = actions.elements.find((e) => e.action_id === action)!.value;
  const payload = { type: 'block_actions', user: { id: user }, container: { channel_id: message.body.channel, message_ts: ts }, actions: [{ action_id: action, value }] };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const response = await interactionsRoute.POST(
    new Request('http://slack.test/api/slack/interactions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...signed(body, secret) }, body }),
  );
  await settleSlackTasks();
  return response;
}

function slackAgent(channel: Partial<AgentChannel> = {}, extra: Record<string, unknown> = {}) {
  const created = agentStore.create({
    name: 'Slack helper',
    instructions: 'Be brief.',
    model: { provider: 'openai', model: 'gpt-test', credential: openAiRef },
    channels: [{ id: 'ch1', type: 'slack', credential: slackRef, access: 'public', allowedUsers: [], newSessionAfterMinutes: 0, enabled: true, ...channel }],
    ...extra,
  });
  return agentStore.publish(created.id)!;
}

const mention = (text: string, extra: JsonObject = {}): JsonObject => ({ event: { type: 'app_mention', channel: 'C1', user: 'U1', text, ts: '1700000001.000100', ...extra } });

describe('request verification', () => {
  const headers = (record: Record<string, string>) => new Headers(record);

  it('accepts Slack’s v0 HMAC-SHA256 signature and refuses anything else', () => {
    const body = '{"type":"event_callback"}';
    const now = Date.now();
    const ts = Math.floor(now / 1000);
    expect(verifySlackRequest(SECRET, headers(signed(body, SECRET, ts)), body, now)).toEqual({ ok: true });
    expect(verifySlackRequest(SECRET, headers(signed(body, 'wrong', ts)), body, now)).toMatchObject({ ok: false, reason: 'Invalid Slack signature' });
    expect(verifySlackRequest(SECRET, headers(signed(body, SECRET, ts)), `${body} `, now)).toMatchObject({ ok: false });
    expect(verifySlackRequest(SECRET, headers(signed(body, SECRET, ts - 301)), body, now)).toMatchObject({ ok: false, reason: 'Stale Slack request timestamp' });
    expect(verifySlackRequest(SECRET, headers({}), body, now)).toMatchObject({ ok: false, reason: 'Missing Slack signature headers' });
    // Slack's documented example.
    expect(slackSignature('8f742231b10e8888abcd99yyyzzz85a5', 1531420618, 'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c')).toBe(
      'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503',
    );
  });

  it('keeps /api/slack reachable without a session (Slack signs instead)', () => {
    expect(isPublicPath('/api/slack/events/a/b')).toBe(true);
    expect(isPublicPath('/api/slack/interactions')).toBe(true);
    expect(isPublicPath('/chat/support')).toBe(true);
  });

  it('answers url_verification and refuses unsigned or mis-signed events', async () => {
    const agent = slackAgent();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'chal-123' });
    const ok = await eventsRoute.POST(new Request('http://slack.test/x', { method: 'POST', headers: signed(body), body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    expect(await ok.json()).toEqual({ challenge: 'chal-123' });
    const bad = await eventsRoute.POST(new Request('http://slack.test/x', { method: 'POST', headers: signed(body, 'nope'), body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    expect(bad.status).toBe(401);
    const missing = await eventsRoute.POST(new Request('http://slack.test/x', { method: 'POST', body }), { params: Promise.resolve({ agentId: agent.id, channelId: 'ch1' }) });
    expect(missing.status).toBe(401);
    expect((await sendEvent(agent.id, 'nope', mention('hi'))).status).toBe(404);
  });

  it('refuses events when the credential has no signing secret', async () => {
    const unsigned = credentials.create({ name: 'No secret', type: 'messaging.slackApi', data: { accessToken: TOKEN, baseUrl: slack.url } });
    const agent = slackAgent({ credential: { id: unsigned.id, name: unsigned.name } });
    const response = await sendEvent(agent.id, 'ch1', mention('hi'));
    expect(response.status).toBe(401);
    expect(slack.calls).toHaveLength(0);
  });
});

describe('Slack agent channel', () => {
  it('answers a mention in its thread; the thread is one session', async () => {
    const agent = slackAgent();
    const response = await sendEvent(agent.id, 'ch1', mention('<@U0BOT> what is up?'));
    expect(response.status).toBe(200);
    const [reply] = slack.of('chat.postMessage');
    expect(reply.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(reply.body).toMatchObject({ channel: 'C1', thread_ts: '1700000001.000100', text: 'Echo: what is up?' });

    // A follow-up in the thread continues the session.
    await sendEvent(agent.id, 'ch1', mention('<@U0BOT> and now?', { ts: '1700000002.000200', thread_ts: '1700000001.000100' }));
    expect(slack.of('chat.postMessage')[1].body).toMatchObject({ thread_ts: '1700000001.000100', text: 'Echo: and now?' });
    const sessions = agentStore.listSessions(agent.id);
    expect(sessions).toHaveLength(1);
    expect(agentStore.getSession(sessions[0].id)).toMatchObject({ source: 'slack', userId: 'slack:U1', conversationKey: 'slack:ch1:C1:1700000001.000100' });
    expect(sessions[0].turns).toBe(2);
  });

  it('answers direct messages and ignores bots, edits and retries', async () => {
    const agent = slackAgent();
    await sendEvent(agent.id, 'ch1', { event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U2', text: 'hello in private', ts: '1700000003.000300' } }, { eventId: 'EvDM' });
    expect(slack.of('chat.postMessage')).toHaveLength(1);
    expect(slack.of('chat.postMessage')[0].body).toMatchObject({ channel: 'D1', text: 'Echo: hello in private' });

    // The same event again (Slack retried it): no second answer.
    const retry = await sendEvent(agent.id, 'ch1', { event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U2', text: 'hello in private', ts: '1700000003.000300' } }, { eventId: 'EvDM' });
    expect(retry.status).toBe(200);
    await sendEvent(agent.id, 'ch1', { event: { type: 'message', channel_type: 'im', channel: 'D1', bot_id: 'B1', user: 'U0BOT', text: 'my own reply', ts: '1' } });
    await sendEvent(agent.id, 'ch1', { event: { type: 'message', subtype: 'message_changed', channel_type: 'im', channel: 'D1', user: 'U2', text: 'edit', ts: '2' } });
    expect(slack.of('chat.postMessage')).toHaveLength(1);
  });

  it('only talks to allowed members of a private channel', async () => {
    const agent = slackAgent({ access: 'private', allowedUsers: ['U_ALLOWED'] });
    await sendEvent(agent.id, 'ch1', mention('hi', { user: 'U_STRANGER' }));
    expect(slack.of('chat.postMessage')[0].body.text).toContain('only talks to people its owner allowed');
    await sendEvent(agent.id, 'ch1', mention('hi', { user: 'U_ALLOWED' }));
    expect(slack.of('chat.postMessage')[1].body.text).toBe('Echo: hi');
  });

  it('asks for tool approvals with buttons and continues in the thread once approved', async () => {
    const agent = slackAgent({}, { tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo the input', nodeType: 'core.noOp', parameters: {}, requireApproval: true }] });
    await sendEvent(agent.id, 'ch1', mention('<@U0BOT> use the tool'));
    const [ask] = slack.of('chat.postMessage');
    expect(ask.body).toMatchObject({ channel: 'C1', thread_ts: '1700000001.000100', text: 'Slack helper: approve Echo?' });
    const buttons = (ask.body.blocks as JsonObject[]).find((b) => b.type === 'actions') as { elements: Array<{ action_id: string }> };
    expect(buttons.elements.map((e) => e.action_id)).toEqual([APPROVE_ACTION, REJECT_ACTION]);
    const session = agentStore.listSessions(agent.id)[0];
    expect(agentStore.getSession(session.id)!.status).toBe('awaiting_approval');

    // A new message in the thread waits for the decision.
    await sendEvent(agent.id, 'ch1', mention('<@U0BOT> hurry', { ts: '1700000001.000200', thread_ts: '1700000001.000100' }));
    expect(slack.of('chat.postMessage')[1].body.text).toContain('waiting for an approval');

    const response = await click(ask, APPROVE_ACTION, 'U1');
    expect(response.status).toBe(200);
    const [update] = slack.of('chat.update');
    expect(update.body).toMatchObject({ channel: 'C1', ts: ask.ts, text: 'Echo: approved' });
    expect(JSON.stringify(update.body.blocks)).toContain('Approved by <@U1>');
    const final = slack.of('chat.postMessage').at(-1)!;
    expect(final.body).toMatchObject({ channel: 'C1', thread_ts: '1700000001.000100', text: expect.stringContaining('The answer is') });
    const done = agentStore.getSession(session.id)!;
    expect(done.status).toBe('idle');
    expect(done.timeline.find((e) => e.type === 'tool')).toMatchObject({ status: 'success' });
  });

  it('refuses clicks signed by another Slack app, and unsigned clicks', async () => {
    const agent = slackAgent({}, { tools: [{ id: 't1', type: 'node', name: 'Echo', description: 'Echo', nodeType: 'core.noOp', parameters: {}, requireApproval: true }] });
    await sendEvent(agent.id, 'ch1', mention('<@U0BOT> use the tool'));
    const [ask] = slack.of('chat.postMessage');
    await click(ask, APPROVE_ACTION, 'U1', 'other-secret');
    expect(slack.of('chat.update')).toHaveLength(0);
    expect(agentStore.getSession(agentStore.listSessions(agent.id)[0].id)!.status).toBe('awaiting_approval');
    const forged = await click(ask, APPROVE_ACTION, 'U1', 'not-a-secret-anyone-has');
    expect(forged.status).toBe(401);
  });
});

describe('AI Agent node approvals in Slack (workflows)', () => {
  const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
  const edge = (source: string, target: string, type: 'main' | 'ai_languageModel' | 'ai_tool' = 'main') => ({ id: `${source}-${target}`, type, source, target, sourceIndex: 0, targetIndex: 0 });

  function approvalWorkflow(id: string): Workflow {
    const workflow: Workflow = {
      id,
      name: `Slack approvals ${id}`,
      nodes: [
        node('Start', 'core.manualTrigger'),
        node(
          'Agent',
          'core.aiAgent',
          { prompt: 'What is 6*7?', requireApproval: 'all', approvalChannel: 'slack', slackChannel: 'C_APPROVALS', slackApprovers: 'U_BOSS' },
          { credentials: { 'messaging.slackApi': slackRef } },
        ),
        node('Model', 'core.openAiChatModel', { model: 'gpt-test' }, { credentials: { openAiApi: openAiRef } }),
        node('Calculator', 'core.calculatorTool'),
      ],
      connections: [edge('Start', 'Agent'), edge('Model', 'Agent', 'ai_languageModel'), edge('Calculator', 'Agent', 'ai_tool')],
    };
    store.saveWorkflow(workflow);
    return workflow;
  }

  it('posts the call with buttons, ignores non-approvers and other apps, resumes on the approver’s click', async () => {
    const workflow = approvalWorkflow('wf_slack_approval');
    const waiting = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    expect(waiting.error?.message).toBeUndefined();
    expect(waiting.status).toBe('waiting');
    expect(waiting.wait?.data?.approval).toMatchObject({ channel: 'slack', slack: { channel: 'C_APPROVALS', approvers: ['U_BOSS'], messages: { call_1: expect.any(String) } } });
    const [ask] = slack.of('chat.postMessage');
    expect(ask.body).toMatchObject({ channel: 'C_APPROVALS', text: 'Agent: approve Calculator?' });
    expect(JSON.stringify(ask.body.blocks)).toContain('6*7');

    // Not an approver: nothing happens.
    await click(ask, APPROVE_ACTION, 'U_OTHER');
    expect(store.getExecution(waiting.executionId)!.status).toBe('waiting');
    // Signed by another Slack app than the node's: refused.
    await click(ask, APPROVE_ACTION, 'U_BOSS', 'other-secret');
    expect(store.getExecution(waiting.executionId)!.status).toBe('waiting');
    expect(slack.of('chat.update')).toHaveLength(0);

    await click(ask, APPROVE_ACTION, 'U_BOSS');
    const done = store.getExecution(waiting.executionId)!;
    expect(done.status).toBe('success');
    expect(done.runData.Agent.at(-1)!.outputs[0][0].json).toMatchObject({ output: expect.stringContaining('42') });
    const [update] = slack.of('chat.update');
    expect(update.body).toMatchObject({ channel: 'C_APPROVALS', ts: ask.ts, text: 'Calculator: approved' });
    expect((waiting.wait!.data!.approval as { slack: { messages: Record<string, string> } }).slack.messages.call_1).toBe(ask.ts);
    expect(JSON.stringify(update.body.blocks)).toContain('Approved by <@U_BOSS>');
    expect(update.headers.authorization).toBe(`Bearer ${TOKEN}`);
    void otherApp;
  });

  it('a Reject click lets the run finish without running the tool', async () => {
    const workflow = approvalWorkflow('wf_slack_reject');
    const waiting = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
    const [ask] = slack.of('chat.postMessage');
    await click(ask, REJECT_ACTION, 'U_BOSS');
    const done = store.getExecution(waiting.executionId)!;
    expect(done.status).toBe('success');
    const steps = (done.runData.Agent.at(-1)!.outputs[0][0].json as { steps: Array<{ output: string }> }).steps;
    expect(steps[0].output).toBe('Not run: rejected by slack:U_BOSS');
    expect(JSON.stringify(slack.of('chat.update')[0].body.blocks)).toContain('Rejected by <@U_BOSS>');
  });
});
