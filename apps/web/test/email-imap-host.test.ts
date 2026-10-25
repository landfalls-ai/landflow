/**
 * Email Trigger (IMAP) in the host, against GreenMail: a published workflow's trigger is polled by the poller (baseline
 * first, then runs for new mail with the attachments in the run's binary scope), and with "Listen: IDLE"
 * (lib/server/imap-idle.ts) new mail starts a run without waiting for the poll interval.
 *
 *   docker compose -f deploy/compose.infra.yml --profile mail up -d greenmail
 *   LANDFLOW_INTEGRATION=imap npx vitest run test/email-imap-host.test.ts
 */
import { mkdtempSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Workflow } from '@landflow/engine';
import { binaryScopeOf } from '@landflow/protocol';

vi.setConfig({ testTimeout: 40_000 });

const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('imap'));
const HOST = process.env.LANDFLOW_GREENMAIL_HOST ?? '127.0.0.1';
const IMAP_PORT = Number(process.env.LANDFLOW_GREENMAIL_IMAP_PORT ?? 53143);
const SMTP_PORT = Number(process.env.LANDFLOW_GREENMAIL_SMTP_PORT ?? 53025);

const dataDir = mkdtempSync(join(tmpdir(), 'landflow-imap-host-'));
const ENV = { LANDFLOW_DATA_DIR: dataDir, LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' };
const previousEnv = { ...process.env };
Object.assign(process.env, ENV);

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { store } = await import('@/lib/server/store');
const { credentials } = await import('@/lib/server/credentials/vault');
const { publishDraft, unpublishWorkflow } = await import('@/lib/server/publish');
const { poller } = await import('@/lib/server/poller');
const { imapIdle } = await import('@/lib/server/imap-idle');
const { binaryStore } = await import('@/lib/server/binary/access');
const { readAll } = await import('@/lib/server/binary/store');

registry.registerBuiltin(corePlugin);

afterAll(() => {
  imapIdle.stop();
  for (const key of Object.keys(ENV)) {
    if (previousEnv[key] === undefined) delete process.env[key];
    else process.env[key] = previousEnv[key];
  }
});

/** One message over SMTP (GreenMail accepts any sender and creates the recipient's mailbox). */
function sendMail(to: string, subject: string, attachment?: string) {
  const body = attachment
    ? [
        'Content-Type: multipart/mixed; boundary="b1"',
        '',
        '--b1',
        'Content-Type: text/plain; charset=utf-8',
        '',
        `Body of ${subject}`,
        '--b1',
        'Content-Type: text/plain; name="note.txt"',
        'Content-Disposition: attachment; filename="note.txt"',
        '',
        attachment,
        '--b1--',
      ]
    : ['Content-Type: text/plain; charset=utf-8', '', `Body of ${subject}`];
  const message = [`From: sender@landflow.test`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', ...body, ''].join('\r\n');
  const script = ['EHLO landflow.test', 'MAIL FROM:<sender@landflow.test>', `RCPT TO:<${to}>`, 'DATA', `${message}\r\n.`, 'QUIT'];
  return new Promise<void>((resolve, reject) => {
    const socket = connect(SMTP_PORT, HOST);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!/^\d{3} /.test(line)) continue;
        if (Number(line.slice(0, 3)) >= 400) return reject(new Error(`SMTP: ${line}`));
        const next = script.shift();
        if (next === undefined) return resolve(void socket.end());
        socket.write(`${next}\r\n`);
      }
    });
    socket.on('error', reject);
  });
}

async function until<T>(check: () => T | undefined, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('timed out');
}

describe.skipIf(!enabled)('Email Trigger (IMAP) in the host', () => {
  const user = `host-${Date.now().toString(36)}@landflow.test`;
  const id = 'wf_imap_host';
  let workflow: Workflow;

  beforeAll(async () => {
    await sendMail(user, 'Already there');
    const credential = credentials.create({ name: 'GreenMail', type: 'core.imap', data: { user, password: 'any', host: HOST, port: IMAP_PORT, secure: false } });
    workflow = {
      id,
      name: 'Inbox',
      nodes: [
        {
          id: 'mail',
          name: 'Mail',
          type: 'core.emailReadImap',
          typeVersion: 1,
          position: [0, 0],
          parameters: { pollInterval: 3600, mailbox: 'INBOX', listen: 'poll', postProcessAction: 'read', downloadAttachments: true },
          credentials: { imap: { id: credential.id, name: credential.name } },
        },
      ],
      connections: [],
    };
    store.saveWorkflow(workflow);
    await publishDraft(id);
  });

  const runs = () => store.listExecutions({ workflowId: id }).filter((e) => e.mode === 'poll');

  it('polls the published trigger: a baseline, then a run per poll with the attachments stored for the run', async () => {
    const baseline = await poller.pollNow(id, 'mail');
    expect(baseline).toMatchObject({ polls: 1, lastItems: 0 });
    expect(baseline.lastError).toBeUndefined();

    await sendMail(user, 'Invoice', 'total: 42');
    const status = await poller.pollNow(id, 'mail');
    expect(status).toMatchObject({ lastItems: 1 });
    const summary = await until(() => runs().find((e) => e.id === status.lastExecutionId && e.status === 'success'));
    const run = store.getExecution(summary.id)!;
    const item = run.runData.mail?.[0]?.outputs?.[0]?.[0];
    expect(item?.json.subject).toBe('Invoice');
    // The poll stored the file in the scope of the execution it started: it goes when the execution is deleted.
    const ref = item!.binary!.attachment_0;
    expect(binaryScopeOf(ref.id)).toBe(summary.id);
    const file = await (await binaryStore()).open(ref.id!);
    expect(Buffer.from(await readAll(file!.stream)).toString().trim()).toBe('total: 42');
  });

  it('IDLE: new mail starts a run without waiting for the poll interval', async () => {
    store.saveWorkflow({ ...workflow, nodes: [{ ...workflow.nodes[0], parameters: { ...workflow.nodes[0].parameters, listen: 'idle' } }] });
    await publishDraft(id);
    imapIdle.start();
    await until(() => (imapIdle.status().find((w) => w.workflowId === id)?.connected ? true : undefined));
    const before = runs().length;
    await new Promise((resolve) => setTimeout(resolve, 1_500)); // auto-IDLE starts a second after the mailbox opened
    await sendMail(user, 'Pushed');
    const run = await until(() => runs().length > before ? runs()[0] : undefined, 20_000);
    expect(run).toBeDefined();

    await unpublishWorkflow(id);
    await until(() => (imapIdle.status().some((w) => w.workflowId === id) ? undefined : true));
  });
});
