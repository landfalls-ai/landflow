/**
 * The Ask a Person node (core.confirmDraft, lib/server/nodes/confirm.ts): it puts the execution to wait with one
 * `confirm` call, a decision through POST /api/executions/:id/approvals (or a Slack click, or an email link) resumes it with
 * the person's text and comment, a rejection leaves on the Rejected output, a timeout settles with the node's default.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workflow, WorkflowNode } from '@landflow/engine';
import type { JsonObject } from '@landflow/protocol';
import { readSse, startFakeSlack } from './fake-ai-services';

vi.setConfig({ testTimeout: 20_000 });

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-confirm-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { defineCredentialType, definePlugin } = await import('@landflow/sdk');
const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { runWorkflow, resumeExecution } = await import('@/lib/server/runner');
const { decideApproval, pendingApproval } = await import('@/lib/server/approvals');
const { approvalLinks } = await import('@/lib/server/approval-email');
const { APPROVE_ACTION, EDIT_ACTION, EDIT_MODAL, REJECT_ACTION, settleSlackTasks, slackSignature } = await import('@/lib/server/slack');
const approvalsRoute = await import('@/app/api/executions/[id]/approvals/route');
const interactionsRoute = await import('@/app/api/slack/interactions/route');
const { needsYou } = await import('@/lib/server/journal/needs-you');

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

const SECRET = 'confirm-signing-secret';
const TOKEN = 'xoxb-confirm';
const slack = await startFakeSlack({ token: TOKEN });
const slackApp = credentials.create({ name: 'Slack app', type: 'messaging.slackApi', data: { accessToken: TOKEN, baseUrl: slack.url, signingSecret: SECRET } });
const slackRef = { id: slackApp.id, name: slackApp.name };

afterAll(async () => {
  await settleSlackTasks();
  await slack.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

beforeEach(() => {
  slack.calls.length = 0;
});

const node = (id: string, type: string, parameters: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters, ...extra });
const edge = (source: string, target: string, sourceIndex = 0) => ({ id: `${source}-${target}-${sourceIndex}`, type: 'main' as const, source, target, sourceIndex, targetIndex: 0 });

/** Start → Ask → Sent (Approved) / Dropped (Rejected). */
function workflow(id: string, ask: Record<string, unknown> = {}, extra: Partial<WorkflowNode> = {}): Workflow {
  const flow: Workflow = {
    id,
    name: `Ask ${id}`,
    nodes: [node('Start', 'core.manualTrigger'), node('Ask', 'core.confirmDraft', { draft: 'Daily summary: all quiet.', title: 'Send the summary?', ...ask }, extra), node('Sent', 'core.noOp'), node('Dropped', 'core.noOp')],
    connections: [edge('Start', 'Ask'), edge('Ask', 'Sent', 0), edge('Ask', 'Dropped', 1)],
  };
  store.saveWorkflow(flow);
  return flow;
}

async function start(flow: Workflow) {
  const waiting = await runWorkflow({ workflow: flow, mode: 'manual', startNodeId: 'Start' });
  expect(waiting.error?.message).toBeUndefined();
  expect(waiting.status).toBe('waiting');
  return waiting;
}

/** POST the approvals route like the Run Trace card does. */
async function answer(executionId: string, body: JsonObject) {
  const response = await approvalsRoute.POST(
    new Request(`http://landflow.test/api/executions/${executionId}/approvals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ callId: 'confirm', ...body }) }),
    { params: Promise.resolve({ id: executionId }) },
  );
  if (!(response.headers.get('content-type') ?? '').includes('event-stream')) return { response, events: [] };
  return { response, events: await readSse(response) };
}

const outputs = (executionId: string, name: string) => store.getExecution(executionId)!.runData[name]?.at(-1)?.outputs;

describe('Ask a Person', () => {
  it('waits with the request, and an approval continues on Approved with the same text', async () => {
    const waiting = await start(workflow('wf_confirm_plain'));
    const approval = pendingApproval(store.getExecution(waiting.executionId));
    expect(approval).toMatchObject({ channel: 'chat', title: 'Send the summary?', calls: [{ id: 'confirm', input: { text: 'Daily summary: all quiet.' } }], confirm: { title: 'Send the summary?', text: 'Daily summary: all quiet.', allowEdit: true } });
    // The Needs you list says who is waited for and what.
    expect((await needsYou(undefined)).find((i) => i.executionId === waiting.executionId)).toMatchObject({ kind: 'approval', title: 'Waiting for a person: Send the summary?' });

    const { response, events } = await answer(waiting.executionId, { approved: true, comment: 'Looks right' });
    expect(response.status).toBe(200);
    expect(events.find((e) => e.event === 'result')!.data.status).toBe('success');
    const done = store.getExecution(waiting.executionId)!;
    expect(done.status).toBe('success');
    const json = outputs(waiting.executionId, 'Ask')![0][0].json;
    expect(json).toMatchObject({ approved: true, edited: false, text: 'Daily summary: all quiet.', originalText: 'Daily summary: all quiet.', comment: 'Looks right', channel: 'chat' });
    expect(json.at).toEqual(expect.any(String));
    expect(outputs(waiting.executionId, 'Ask')![1]).toEqual([]);
    expect(done.runData.Sent).toBeDefined();
    expect(done.runData.Dropped).toBeUndefined();
  });

  it('an edited approval resumes with the new text and says it was edited', async () => {
    const waiting = await start(workflow('wf_confirm_edit'));
    const { events } = await answer(waiting.executionId, { approved: true, text: 'Daily summary: one alert, handled.' });
    expect(events.find((e) => e.event === 'result')!.data.status).toBe('success');
    expect(outputs(waiting.executionId, 'Ask')![0][0].json).toMatchObject({ approved: true, edited: true, text: 'Daily summary: one alert, handled.', originalText: 'Daily summary: all quiet.' });
  });

  it('a rejection leaves on the Rejected output, and text cannot ride on it', async () => {
    const waiting = await start(workflow('wf_confirm_reject'));
    const bad = await answer(waiting.executionId, { approved: false, text: 'x' });
    expect(bad.response.status).toBe(400);
    await answer(waiting.executionId, { approved: false, comment: 'Not today' });
    const done = store.getExecution(waiting.executionId)!;
    expect(done.status).toBe('success');
    expect(outputs(waiting.executionId, 'Ask')![0]).toEqual([]);
    expect(outputs(waiting.executionId, 'Ask')![1][0].json).toMatchObject({ approved: false, edited: false, comment: 'Not today' });
    expect(done.runData.Dropped).toBeDefined();
    expect(done.runData.Sent).toBeUndefined();
  });

  it('refuses edited text when the node does not allow editing, and people who may not answer', async () => {
    const locked = await start(workflow('wf_confirm_locked', { allowEdit: false, approvers: 'boss@example.com' }));
    // Errors found while deciding come back inside the stream, as on the tool approvals.
    const refused = await answer(locked.executionId, { approved: true, text: 'changed' });
    expect(refused.events.find((e) => e.event === 'result')!.data).toMatchObject({ status: 'error', httpStatus: 403 });
    // The synthetic owner of the tests is not on the list.
    await expect(decideApproval(locked.executionId, 'confirm', true, { by: 'someone@example.com' })).rejects.toMatchObject({ status: 403 });
    expect(store.getExecution(locked.executionId)!.status).toBe('waiting');
    const outcome = await decideApproval(locked.executionId, 'confirm', true, { by: 'Boss@Example.com' });
    expect(outcome.status).toBe('resumed');
    // Answered once.
    await expect(decideApproval(locked.executionId, 'confirm', true, { by: 'boss@example.com' })).rejects.toMatchObject({ status: 409 });
  });

  it('settles a timeout with the default outcome: reject, approve or fail', async () => {
    const rejecting = await start(workflow('wf_confirm_timeout_reject', { timeoutMinutes: 5 }));
    expect(store.getExecution(rejecting.executionId)!.wait!.until).toEqual(expect.any(String));
    await resumeExecution(rejecting.executionId, { kind: 'timeout' });
    expect(outputs(rejecting.executionId, 'Ask')![1][0].json).toMatchObject({ approved: false, by: 'timeout' });

    const approving = await start(workflow('wf_confirm_timeout_approve', { timeoutMinutes: 5, onTimeout: 'approve' }));
    await resumeExecution(approving.executionId, { kind: 'timeout' });
    expect(outputs(approving.executionId, 'Ask')![0][0].json).toMatchObject({ approved: true, edited: false, by: 'timeout', text: 'Daily summary: all quiet.' });

    const failing = await start(workflow('wf_confirm_timeout_fail', { timeoutMinutes: 5, onTimeout: 'fail' }));
    const failed = await resumeExecution(failing.executionId, { kind: 'timeout' });
    expect(failed.status).toBe('error');
    expect(failed.error?.message).toContain('Nobody answered');
  });

  it('survives a restart: the waiting execution is read back from the store and answered', async () => {
    const waiting = await start(workflow('wf_confirm_restart'));
    // Nothing of it lives in memory: the store's record is all there is.
    const record = store.getExecution(waiting.executionId)!;
    expect(record.status).toBe('waiting');
    const outcome = await decideApproval(waiting.executionId, 'confirm', true, { by: 'ana@example.com', text: 'Edited after restart' });
    expect(outcome.status).toBe('resumed');
    expect(outputs(waiting.executionId, 'Ask')![0][0].json).toMatchObject({ text: 'Edited after restart', by: 'ana@example.com' });
  });

  it('an empty draft fails the node', async () => {
    const result = await runWorkflow({ workflow: workflow('wf_confirm_empty', { draft: '  ' }), mode: 'manual', startNodeId: 'Start' });
    expect(result.status).toBe('error');
    expect(result.error?.message).toContain('draft is empty');
  });

  it('an email link rejects or approves a request', async () => {
    const waiting = await start(workflow('wf_confirm_email'));
    const { useLink, confirmationPage } = await import('@/lib/server/approval-email');
    const links = approvalLinks({ t: 'wf', e: waiting.executionId, c: 'confirm' }, 'ana@example.com');
    const token = new URL(links.approve).pathname.split('/').pop()!;
    const page = await (await confirmationPage(token)).text();
    expect(page).toContain('Send the summary?');
    expect(page).toContain('Daily summary: all quiet.');
    await useLink(token);
    expect(outputs(waiting.executionId, 'Ask')![0][0].json).toMatchObject({ approved: true, by: 'email:ana@example.com', channel: 'email' });
  });
});

describe('Ask a Person in Slack', () => {
  const sign = (body: string, secret = SECRET) => {
    const ts = Math.floor(Date.now() / 1000);
    return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': slackSignature(secret, ts, body) };
  };
  async function post(payload: JsonObject) {
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const response = await interactionsRoute.POST(new Request('http://slack.test/api/slack/interactions', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...sign(body) }, body }));
    await settleSlackTasks();
    return response;
  }
  const click = (message: { body: { channel: string; blocks?: JsonObject[] }; ts?: string }, action: string, user: string, extra: JsonObject = {}) => {
    const actions = (message.body.blocks ?? []).find((b) => b.type === 'actions') as { elements: Array<{ action_id: string; value: string }> };
    const value = actions.elements.find((e) => e.action_id === action)!.value;
    return post({ type: 'block_actions', user: { id: user }, trigger_id: 'trig1', container: { channel_id: message.body.channel, message_ts: message.ts }, actions: [{ action_id: action, value }], ...extra });
  };
  const slackWorkflow = (id: string, extra: Record<string, unknown> = {}) => workflow(id, { channel: 'slack', slackChannel: 'C_REVIEW', approvers: 'U_BOSS', ...extra }, { credentials: { 'messaging.slackApi': slackRef } });

  it('posts Approve / Edit / Reject, and an Approve click continues and updates the message', async () => {
    const waiting = await start(slackWorkflow('wf_confirm_slack_approve'));
    const [ask] = slack.of('chat.postMessage');
    expect(ask.body).toMatchObject({ channel: 'C_REVIEW' });
    const ids = ((ask.body.blocks as JsonObject[]).find((b) => b.type === 'actions') as { elements: Array<{ action_id: string }> }).elements.map((e) => e.action_id);
    expect(ids).toEqual([APPROVE_ACTION, EDIT_ACTION, REJECT_ACTION]);
    expect(JSON.stringify(ask.body.blocks)).toContain('Daily summary: all quiet.');

    await click(ask, APPROVE_ACTION, 'U_OTHER');
    expect(store.getExecution(waiting.executionId)!.status).toBe('waiting');
    await click(ask, APPROVE_ACTION, 'U_BOSS');
    expect(store.getExecution(waiting.executionId)!.status).toBe('success');
    expect(outputs(waiting.executionId, 'Ask')![0][0].json).toMatchObject({ approved: true, edited: false, by: 'slack:U_BOSS', channel: 'slack' });
    await vi.waitFor(() => expect(slack.of('chat.update')).toHaveLength(1));
    const [update] = slack.of('chat.update');
    expect(update.body).toMatchObject({ channel: 'C_REVIEW', ts: ask.ts, text: 'Send the summary?: approved' });
    expect(JSON.stringify(update.body.blocks)).toContain('Approved by <@U_BOSS>');
    expect(JSON.stringify(update.body.blocks)).not.toContain('landflow_approve');
  });

  it('Edit opens a modal with the draft; submitting it approves with the edited text and a comment', async () => {
    const waiting = await start(slackWorkflow('wf_confirm_slack_edit'));
    const [ask] = slack.of('chat.postMessage');
    await click(ask, EDIT_ACTION, 'U_BOSS');
    const [open] = slack.of('views.open');
    expect(open.body).toMatchObject({ trigger_id: 'trig1', view: { type: 'modal', callback_id: EDIT_MODAL } });
    const view = open.body.view as { private_metadata: string; blocks: Array<{ block_id: string; element: { initial_value?: string } }> };
    expect(view.blocks.find((b) => b.block_id === 'text')!.element.initial_value).toBe('Daily summary: all quiet.');
    expect(store.getExecution(waiting.executionId)!.status).toBe('waiting');

    // An empty text keeps the modal open with an error.
    const empty = await post({ type: 'view_submission', user: { id: 'U_BOSS' }, view: { callback_id: EDIT_MODAL, private_metadata: view.private_metadata, state: { values: { text: { text: { value: '  ' } } } } } });
    expect(await empty.json()).toMatchObject({ response_action: 'errors' });

    const submitted = await post({
      type: 'view_submission',
      user: { id: 'U_BOSS' },
      view: { callback_id: EDIT_MODAL, private_metadata: view.private_metadata, state: { values: { text: { text: { value: 'Daily summary: one alert.' } }, comment: { comment: { value: 'Added the alert' } } } } },
    });
    expect(submitted.status).toBe(200);
    expect(store.getExecution(waiting.executionId)!.status).toBe('success');
    expect(outputs(waiting.executionId, 'Ask')![0][0].json).toMatchObject({ approved: true, edited: true, text: 'Daily summary: one alert.', comment: 'Added the alert', by: 'slack:U_BOSS' });
    await vi.waitFor(() => expect(slack.of('chat.update')).toHaveLength(1));
    const [update] = slack.of('chat.update');
    expect(update.body.text).toBe('Send the summary?: approved with changes');
    expect(JSON.stringify(update.body.blocks)).toContain('Daily summary: one alert.');
    expect(JSON.stringify(update.body.blocks)).toContain('Approved with changes by <@U_BOSS>');
  });

  it('a Reject click goes to the Rejected output; no Edit button when editing is off', async () => {
    const waiting = await start(slackWorkflow('wf_confirm_slack_reject', { allowEdit: false }));
    const [ask] = slack.of('chat.postMessage');
    expect(JSON.stringify(ask.body.blocks)).not.toContain(EDIT_ACTION);
    await click(ask, REJECT_ACTION, 'U_BOSS');
    expect(outputs(waiting.executionId, 'Ask')![1][0].json).toMatchObject({ approved: false, by: 'slack:U_BOSS' });
    await vi.waitFor(() => expect(slack.of('chat.update')).toHaveLength(1));
    expect(JSON.stringify(slack.of('chat.update')[0].body.blocks)).toContain('Rejected by <@U_BOSS>');
  });

  it('a timeout updates the Slack message with how it settled', async () => {
    const waiting = await start(slackWorkflow('wf_confirm_slack_timeout', { timeoutMinutes: 5, onTimeout: 'approve' }));
    await resumeExecution(waiting.executionId, { kind: 'timeout' });
    expect(outputs(waiting.executionId, 'Ask')![0][0].json).toMatchObject({ approved: true, by: 'timeout', channel: 'slack' });
    await vi.waitFor(() => expect(slack.of('chat.update')).toHaveLength(1));
    expect(JSON.stringify(slack.of('chat.update')[0].body.blocks)).toContain('No answer in time: approved automatically');
  });
});
