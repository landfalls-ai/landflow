/**
 * Suggestions with an audience (docs/second-brain.md#suggestions-with-an-audience): addressing a suggestion to named people
 * (who see it wherever it is about, but may only apply changes they can edit), Suggest Improvement's Send To and Mirror to
 * Slack, the buttons in the direct message (against the fake Slack server), and the messages catching up with every decision.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { JsonObject } from '@landflow/protocol';
import type { Proposal } from '@/lib/shared/brain';
import { startFakeSlack } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-audience-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '', LANDFLOW_BRAIN_MODEL: 'off', LANDFLOW_BRAIN_EMBEDDINGS: 'off' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { definePlugin, defineCredentialType } = await import('@landflow/sdk');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { database } = await import('@/lib/server/db');
const { credentials } = await import('@/lib/server/credentials/vault');
const { createUser } = await import('@/lib/server/auth/users');
const { enableTestAuth } = await import('@/lib/server/auth/test-bypass');
const { runWorkflow } = await import('@/lib/server/runner');
const proposals = await import('@/lib/server/brain/proposals');
const { cleanAudience, canDecide, canSee, settleMirrors } = await import('@/lib/server/brain/audience');
const { settleSlackTasks, slackSignature } = await import('@/lib/server/slack');
const proposalsRoute = await import('@/app/api/proposals/route');
const proposalRoute = await import('@/app/api/proposals/[id]/route');
const applyRoute = await import('@/app/api/proposals/[id]/apply/route');
const interactionsRoute = await import('@/app/api/slack/interactions/route');

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(
  definePlugin({
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
  }),
);

const SECRET = 'audience-signing-secret';
const slack = await startFakeSlack({ token: 'xoxb-audience' });
const slackApp = credentials.create({ name: 'Slack app', type: 'messaging.slackApi', data: { accessToken: 'xoxb-audience', baseUrl: slack.url, signingSecret: SECRET } });
const slackRef = { id: slackApp.id, name: slackApp.name };

const owner = await createUser({ email: 'owner@audience.test', name: 'Olive Owner', role: 'owner', password: 'owner-password-1' });
const dana = await createUser({ email: 'dana@audience.test', name: 'Dana', role: 'member', password: 'dana-password-1' });

afterAll(async () => {
  await settleSlackTasks();
  await slack.close();
  enableTestAuth();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

const node = (id: string, name: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const link = (source: string, target: string) => ({ id: `${source}-${target}`, type: 'main' as const, source, sourceIndex: 0, target, targetIndex: 0 });

const RETRY = [{ op: 'setNodeSettings', node: 'Call', settings: { retryOnFail: true } }];

function target() {
  return store.saveWorkflow({ id: 'wf_t', name: 'Target flow', active: false, nodes: [node('h', 'Call', 'core.httpRequest')], connections: [], createdBy: owner.id } as Workflow);
}

/** A workflow that posts one suggestion (Suggest Improvement) to the audience, mirrored to Slack. */
async function suggest(id: string, parameters: Record<string, unknown> = {}) {
  const workflow = store.saveWorkflow({
    id,
    name: 'Suggester',
    active: false,
    createdBy: owner.id,
    nodes: [
      node('Start', 'Start', 'core.manualTrigger'),
      node('Suggest', 'Suggest', 'core.suggestImprovement', { title: 'Retry the call', why: 'It times out', workflowId: 'wf_t', ops: JSON.stringify(RETRY), sendTo: 'U_DANA, U_LEE', mirrorToSlack: true, ...parameters }, { credentials: { 'messaging.slackApi': slackRef } }),
    ],
    connections: [link('Start', 'Suggest')],
  } as Workflow);
  const run = await runWorkflow({ workflow, mode: 'manual', startNodeId: 'Start' });
  expect(run.error?.message).toBeUndefined();
  await settleMirrors();
  return run;
}

const open = () => proposals.listProposals({ status: 'all' });

/** Click a button of a message the fake Slack received. */
async function click(message: { body: Record<string, unknown>; ts?: string }, actionId: string, user: string) {
  const blocks = (message.body.blocks ?? []) as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>;
  const value = blocks.find((b) => b.type === 'actions')!.elements!.find((e) => e.action_id === actionId)!.value;
  const payload = { type: 'block_actions', user: { id: user }, container: { channel_id: message.body.channel, message_ts: message.ts }, actions: [{ action_id: actionId, value }] };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const timestamp = Math.floor(Date.now() / 1000);
  const response = await interactionsRoute.POST(
    new Request('http://slack.test/api/slack/interactions', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': String(timestamp), 'x-slack-signature': slackSignature(SECRET, timestamp, body) },
      body,
    }),
  );
  await settleSlackTasks();
  await settleMirrors();
  return response;
}

async function call(handler: unknown, url: string, init: RequestInit & { json?: unknown } = {}, params?: Record<string, string>) {
  const { json: body, ...rest } = init;
  const request = new Request(`http://localhost${url}`, { ...rest, ...(body !== undefined && { method: rest.method ?? 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  const response = await (handler as (r: Request, c?: unknown) => Promise<Response>)(request, params && { params: Promise.resolve(params) });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

beforeEach(() => {
  database().deleteBefore('proposals', 'created_at', '9999');
  slack.calls.length = 0;
  enableTestAuth();
  target();
});

describe('the audience', () => {
  it('resolves emails to Landflow users, takes Slack ids, and refuses what is neither', () => {
    expect(cleanAudience('dana@audience.test, U0123ABCD, Dana@Audience.test')).toEqual([
      { userId: dana.id, email: 'dana@audience.test', name: 'Dana' },
      { slackUserId: 'U0123ABCD' },
    ]);
    expect(cleanAudience([{ email: 'lee@elsewhere.test', name: 'Lee' }])).toEqual([{ email: 'lee@elsewhere.test', name: 'Lee' }]);
    expect(cleanAudience('')).toEqual([]);
    expect(() => cleanAudience('nobody')).toThrow(/neither an email nor a Slack member id/);
    expect(() => cleanAudience(Array.from({ length: 11 }, (_, i) => `u${i}@x.test`))).toThrow(/at most 10/);
  });

  it('shows a suggestion to its audience wherever it is about, but only lets them apply what changes nothing', async () => {
    const withChanges = proposals.proposeFrom({ title: 'Retry the call', why: 'timeouts', workflowId: 'wf_t', ops: RETRY, audience: ['dana@audience.test'] }, 'analyst')!;
    const advice = proposals.proposeFrom({ title: 'Talk to Ada', why: 'overlap', audience: [{ email: 'dana@audience.test' }] }, 'analyst')!;
    const hidden = proposals.proposeFrom({ title: 'Not for Dana', why: 'private', workflowId: 'wf_t' }, 'analyst')!;
    expect(withChanges.audience).toEqual([{ userId: dana.id, email: 'dana@audience.test', name: 'Dana' }]);

    expect(canSee(dana, withChanges)).toBe(true);
    expect(canSee(dana, hidden)).toBe(false);
    expect(canDecide(dana, withChanges, 'other')).toBe(true);
    expect(canDecide(dana, withChanges, 'apply')).toBe(false);
    expect(canDecide(dana, advice, 'apply')).toBe(true);

    enableTestAuth(dana as never);
    const mine = await call(proposalsRoute.GET, '/api/proposals?for=me');
    expect((mine.body.proposals as Proposal[]).map((p) => p.id).sort()).toEqual([advice.id, withChanges.id].sort());
    const all = await call(proposalsRoute.GET, '/api/proposals');
    expect((all.body.proposals as Proposal[]).map((p) => p.id)).not.toContain(hidden.id);
    expect((await call(proposalRoute.GET, `/api/proposals/${hidden.id}`, {}, { id: hidden.id })).status).toBe(404);
    expect((await call(applyRoute.POST, `/api/proposals/${withChanges.id}/apply`, { method: 'POST' }, { id: withChanges.id })).status).toBe(403);
    const snoozed = await call(proposalRoute.PATCH, `/api/proposals/${withChanges.id}`, { method: 'PATCH', json: { action: 'snooze', days: 2 } }, { id: withChanges.id });
    expect(snoozed.status).toBe(200);
    expect((await call(applyRoute.POST, `/api/proposals/${advice.id}/apply`, { method: 'POST' }, { id: advice.id })).status).toBe(400);
  });

  it('takes an audience over POST /api/proposals', async () => {
    const created = await call(proposalsRoute.POST, '/api/proposals', { json: { title: 'Meet Lee', why: 'same customer', audience: [{ email: 'lee@elsewhere.test' }] } });
    expect(created.status).toBe(201);
    expect((created.body.proposal as Proposal).audience).toEqual([{ email: 'lee@elsewhere.test' }]);
    expect((await call(proposalsRoute.POST, '/api/proposals', { json: { title: 'x', why: 'y', audience: [{ email: 'not-an-email' }] } })).status).toBe(400);
  });
});

describe('the Slack mirror', () => {
  it('posts a direct message with the buttons to each member once, and not again on a refresh', async () => {
    await suggest('wf_s1', { actions: { buttons: [{ id: 'intro', label: 'Intro us', style: 'primary', confirm: '' }] } });
    const posts = slack.of('chat.postMessage');
    expect(posts.map((p) => p.body.channel).sort()).toEqual(['U_DANA', 'U_LEE']);
    const text = JSON.stringify(posts[0].body.blocks);
    expect(text).toContain('Retry the call');
    expect(text).toContain('It times out');
    const ids = ((posts[0].body.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>).find((b) => b.type === 'actions')!.elements ?? []).map((e) => e.action_id);
    expect(ids).toEqual(['landflow_pr_act:intro', 'landflow_pr_apply', 'landflow_pr_dismiss', 'landflow_pr_snooze']);
    const [saved] = open();
    expect(saved.slack?.messages.map((m) => m.slackUserId).sort()).toEqual(['U_DANA', 'U_LEE']);

    await suggest('wf_s1');
    expect(slack.of('chat.postMessage')).toHaveLength(2);
    expect(open()).toHaveLength(1);
    // Someone added since gets theirs.
    await suggest('wf_s1', { sendTo: 'U_DANA, U_LEE, U_NEW' });
    expect(slack.of('chat.postMessage').map((p) => p.body.channel)).toEqual(['U_DANA', 'U_LEE', 'U_NEW']);
  });

  it('a button decides the suggestion for everyone: the record, the actor and every message', async () => {
    await suggest('wf_s2', { actions: { buttons: [{ id: 'intro', label: 'Intro us' }] } });
    const [dm] = slack.of('chat.postMessage');
    slack.calls.length = 0;

    // Not in the audience: nothing happens.
    await click(dm, 'landflow_pr_snooze', 'U_STRANGER');
    expect(open()[0].status).toBe('open');
    expect(slack.of('chat.update')).toHaveLength(0);

    await click(dm, 'landflow_pr_act:intro', 'U_DANA');
    const [decided] = open();
    expect(decided).toMatchObject({ status: 'applied', decision: { action: 'intro', label: 'Intro us', by: 'slack:U_DANA' } });
    const updates = slack.of('chat.update');
    expect(updates).toHaveLength(2);
    const body = JSON.stringify(updates[0].body.blocks);
    expect(body).toContain('Intro us by <@U_DANA>');
    expect(body).not.toContain('landflow_pr_apply');
  });

  it('Dismiss and Snooze from Slack use the inbox functions', async () => {
    await suggest('wf_s3');
    const [dm] = slack.of('chat.postMessage');
    await click(dm, 'landflow_pr_snooze', 'U_LEE');
    expect(open()[0]).toMatchObject({ status: 'snoozed', decision: { action: 'snoozed', by: 'slack:U_LEE' } });
    // A snoozed one can still be decided; the buttons stay on its messages.
    expect(JSON.stringify(slack.of('chat.update')[0].body.blocks)).toContain('landflow_pr_dismiss');
    await click(dm, 'landflow_pr_dismiss', 'U_DANA');
    expect(open()[0]).toMatchObject({ status: 'dismissed', reason: 'not-relevant', decision: { by: 'slack:U_DANA' } });
    expect(JSON.stringify(slack.of('chat.update').at(-1)!.body.blocks)).toContain('Dismissed by <@U_DANA>');
  });

  it('Apply needs edit access in Landflow: a member Slack can’t match is refused, the owner’s match applies it', async () => {
    await suggest('wf_s4');
    const [dm] = slack.of('chat.postMessage');
    await click(dm, 'landflow_pr_apply', 'U_DANA');
    expect(open()[0].status).toBe('open');
    expect(store.getWorkflow('wf_t')!.nodes[0].retryOnFail).toBeFalsy();

    const mapped = proposals.proposeFrom(
      { title: 'Retry harder', why: 'again', workflowId: 'wf_t', ops: RETRY, audience: [{ email: 'owner@audience.test', slackUserId: 'U_OWNER' }, { email: 'dana@audience.test', slackUserId: 'U_DANA2' }], slackCredential: slackRef },
      'analyst',
    )!;
    await settleMirrors();
    const dms = slack.of('chat.postMessage').filter((p) => ['U_OWNER', 'U_DANA2'].includes(String(p.body.channel)));
    expect(dms).toHaveLength(2);
    // Dana is a Landflow user without edit access.
    await click(dms.find((p) => p.body.channel === 'U_DANA2')!, 'landflow_pr_apply', 'U_DANA2');
    expect(proposals.getProposal(mapped.id)!.status).toBe('open');
    await click(dms.find((p) => p.body.channel === 'U_OWNER')!, 'landflow_pr_apply', 'U_OWNER');
    const applied = proposals.getProposal(mapped.id)!;
    expect(applied).toMatchObject({ status: 'applied', appliedBy: owner.id, decision: { by: owner.id } });
    expect(store.getWorkflow('wf_t')!.nodes[0].retryOnFail).toBe(true);
    expect(JSON.stringify(slack.of('chat.update').at(-1)!.body.blocks)).toContain('Olive Owner');
  });

  it('a decision in the inbox updates the Slack messages too', async () => {
    await suggest('wf_s5');
    const [saved] = open();
    slack.calls.length = 0;
    proposals.dismissProposal(saved.id, 'wrong', { actorId: owner.id, note: 'we know' });
    await settleMirrors();
    const updates = slack.of('chat.update');
    expect(updates.map((u) => u.body.channel).sort()).toEqual(['U_DANA', 'U_LEE']);
    expect(JSON.stringify(updates[0].body.blocks)).toContain('Dismissed by Olive Owner');
  });
});
