/**
 * AP02 (wave ap1): the inbox wait is durable. A webhook run that waits for an approval survives a "restart" (the timers gone, the
 * port registered again): `waits.start()` re-arms the expiry, an approval resumes the run and the tool runs once; a wait whose
 * `until` passed while the host was down resumes at boot as a timeout, is settled expired by the node and refused (no mail).
 * The execution row, the agent session and the (fake) record are all that is kept: no new loop and no new timer.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { toToolName, type Workflow, type WorkflowNode } from '@landflow/engine';
import { startFakeModels, type FakeReply } from './fake-ai-services';
import { startFakeSmtp } from '../../../plugins/messaging/test/fake-smtp';
import type { InboxOpen } from '@/lib/shared/approval-inbox';
import type { InboxOutcome, InboxPort } from '@/lib/server/approval-inbox/port';

vi.setConfig({ testTimeout: 30_000 });

const smtp = await startFakeSmtp({ auth: { user: 'mail', password: 'pw-ap1-restart-made-up' }, authMethods: ['PLAIN'] });
const ENV = { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-inbox-restart-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { plugin: messaging } = await import('../../../plugins/messaging/src/main');
const { store } = await import('@/lib/server/store');
const { runWorkflow } = await import('@/lib/server/runner');
const { waits } = await import('@/lib/server/waits');
const { agentStore } = await import('@/lib/server/agents/store');
const { decideApproval } = await import('@/lib/server/approvals');
const { credentials } = await import('@/lib/server/credentials/vault');
const { registerInboxPort } = await import('@/lib/server/approval-inbox/port');

registry.registerBuiltin(corePlugin);
registry.registerBuiltin(messaging);

let turn = 0;
const fake = await startFakeModels({
  reply: (): FakeReply => {
    turn += 1;
    return turn === 1 ? { toolCalls: [{ id: 'c_mail', name: toToolName('Send Email'), arguments: {} }] } : { text: 'Handled.' };
  },
});
afterAll(async () => {
  waits.stop();
  await fake.close();
  await smtp.close();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** The record lives with the database in the real inbox; here a map that survives the "restart" while the port object does not. */
const rows = new Map<string, InboxOutcome>();
const opened: InboxOpen[] = [];
const makePort = (expiresAt: string): InboxPort => ({
  async open(calls) {
    opened.push(...calls);
    for (const call of calls) if (!rows.has(`${call.executionId}|${call.callId}`)) rows.set(`${call.executionId}|${call.callId}`, { status: 'waiting' });
    return { ids: Object.fromEntries(calls.map((c) => [c.callId, `ib_${c.callId}`])), expiresAt, minutes: 10 };
  },
  outcome: (executionId, callId) => rows.get(`${executionId}|${callId}`),
  async settle(executionId, callId, to) {
    const k = `${executionId}|${callId}`;
    const current = rows.get(k);
    if (current && current.status !== 'waiting') return { won: false, outcome: current };
    const outcome: InboxOutcome = { status: to, via: 'expiry', at: new Date().toISOString() };
    rows.set(k, outcome);
    return { won: true, outcome };
  },
  view: () => undefined,
});
/** A host restart: the timers and the registered port are gone; the database is what is left. */
const restart = (expiresAt: string) => {
  waits.stop();
  registerInboxPort(undefined as never);
  registerInboxPort(makePort(expiresAt));
};

const smtpCredential = credentials.create({ name: 'Mailpit SMTP', type: 'messaging.smtp', data: { host: '127.0.0.1', port: smtp.port, secure: false, disableStartTls: true, user: 'mail', password: 'pw-ap1-restart-made-up' } }).id;
const mailer = agentStore.create({
  name: 'Alert mailer',
  instructions: 'You email on-call.',
  model: { provider: 'ollama', model: 'mailer-model', baseUrl: fake.url.replace(/\/v1$/, '') },
  tools: [{ id: 'tl_mail', type: 'node', name: 'Send Email', description: 'Email on-call', nodeType: 'messaging.emailSend', parameters: { fromEmail: 'landflow@landflow.test', toEmail: 'oncall@landflow.test', subject: 'Alert', emailFormat: 'text', text: 'Disk is full' }, credentials: { smtp: { id: smtpCredential, name: 'Mailpit SMTP' } }, requireApproval: true }],
} as never);
agentStore.publish(mailer.id);

const node = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type, typeVersion: 1, position: [0, 0], parameters });
let n = 0;
function waitingRun() {
  turn = 0;
  const wf: Workflow = {
    id: `wf_ap1_restart_${++n}`,
    name: 'Alert flow',
    nodes: [node('Start', 'core.webhook', { path: `ap1-restart-${n}` }), node('Agent', 'core.messageAgent', { agentId: mailer.id, message: 'Email on-call', toolApprovals: 'askInChat' })],
    connections: [{ id: 'a', type: 'main', source: 'Start', target: 'Agent', sourceIndex: 0, targetIndex: 0 }],
  };
  store.saveWorkflow(wf);
  return runWorkflow({ workflow: wf, mode: 'webhook', startNodeId: 'Start', triggerItems: [{ json: {} }] });
}
const callOf = (record: Awaited<ReturnType<typeof waitingRun>>) => (record.wait?.data as { approval: { calls: Array<{ id: string }> } }).approval.calls[0]!.id;

describe('the inbox wait across a restart', () => {
  it('re-arms the expiry at boot; an approval then resumes the run and the tool runs once', async () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    registerInboxPort(makePort(until));
    const record = await waitingRun();
    expect(record.status).toBe('waiting');
    expect(record.wait?.until).toBe(until);
    restart(until);
    expect(waits.pending()).toEqual([]);
    waits.start(0);
    expect(waits.pending()).toContain(record.executionId);
    // The record says approved (AP01's claim ran before the door resumed the run).
    rows.set(`${record.executionId}|${callOf(record)}`, { status: 'approved', by: 'usr_owner', byName: 'Owner', via: 'inbox', at: new Date().toISOString() });
    const outcome = await decideApproval(record.executionId, callOf(record), true, { by: 'usr_owner' });
    expect((outcome as { record: { status: string } }).record.status).toBe('success');
    expect(smtp.mails).toHaveLength(1);
    expect(waits.pending()).not.toContain(record.executionId);
  });

  it('a wait whose time passed while the host was down resumes at boot as a timeout and is refused: no mail', async () => {
    smtp.mails.length = 0;
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    registerInboxPort(makePort(until));
    const record = await waitingRun();
    expect(record.status).toBe('waiting');
    restart(until);
    const stored = store.getExecution(record.executionId)!;
    store.saveExecution({ ...stored, wait: { ...stored.wait!, until: new Date(Date.now() - 60_000).toISOString() } });
    waits.start(0);
    await vi.waitFor(() => expect(store.getExecution(record.executionId)?.status).toBe('success'), { timeout: 8_000, interval: 100 });
    expect(rows.get(`${record.executionId}|${callOf(record)}`)).toMatchObject({ status: 'expired' });
    expect(smtp.mails).toHaveLength(0);
    const json = store.getExecution(record.executionId)!.runData.Agent?.at(-1)?.outputs?.[0]?.[0]?.json as { steps: Array<{ status: string }>; reply: string };
    expect(json.steps).toEqual([expect.objectContaining({ status: 'denied' })]);
    expect(json.reply).toBe('Handled.');
  });
});
