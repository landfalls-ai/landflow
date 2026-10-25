/**
 * Email Trigger (IMAP): the item a message becomes (always), and polls against GreenMail (IMAP + SMTP test server):
 *
 *   docker compose -f deploy/compose.infra.yml --profile mail up -d greenmail
 *   LANDFLOW_INTEGRATION=imap npx vitest run test/email-imap.test.ts
 *
 * GreenMail runs with authentication disabled: any login works, and SMTP delivery to an address creates its mailbox.
 * LANDFLOW_GREENMAIL_HOST / _IMAP_PORT / _SMTP_PORT override 127.0.0.1:53143 and :53025.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { simpleParser } from 'mailparser';
import { runNode, type ExecuteRequest, type JsonObject } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';
import { hostBinaryClient, setBinaryStore } from '@/lib/server/binary/access';
import { FilesystemBinaryStore, readAll } from '@/lib/server/binary/store';
import { corePlugin } from '@/lib/server/nodes';
import { closeQuietly, emailReadImapNode, imapClient, imapCredential, messageItem, type ImapCredential } from '@/lib/server/nodes/email-imap';

const enabled = Boolean(process.env.LANDFLOW_INTEGRATION?.split(',').includes('imap'));
const HOST = process.env.LANDFLOW_GREENMAIL_HOST ?? '127.0.0.1';
const IMAP_PORT = Number(process.env.LANDFLOW_GREENMAIL_IMAP_PORT ?? 53143);
const SMTP_PORT = Number(process.env.LANDFLOW_GREENMAIL_SMTP_PORT ?? 53025);

const root = mkdtempSync(join(tmpdir(), 'landflow-imap-'));
const store = new FilesystemBinaryStore(join(root, 'binary'));
setBinaryStore(store);
afterAll(() => rmSync(root, { recursive: true, force: true }));

const CSV = 'id,total\n1,42\n';

function mime({ from, to, subject, text, html, attachment, messageId }: { from: string; to: string; subject: string; text: string; html?: string; attachment?: { name: string; content: string }; messageId: string }) {
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${messageId}`, 'Date: Sat, 24 Oct 2026 10:00:00 +0000', 'MIME-Version: 1.0', 'X-Landflow-Test: yes'];
  if (!html && !attachment) return [...head, 'Content-Type: text/plain; charset=utf-8', '', text, ''].join('\r\n');
  const body = html
    ? `Content-Type: multipart/alternative; boundary="b2"\r\n\r\n--b2\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--b2\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n--b2--\r\n`
    : `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n`;
  const parts = [`--b1\r\n${body}`];
  if (attachment) {
    parts.push(
      `--b1\r\nContent-Type: text/csv; name="${attachment.name}"\r\nContent-Disposition: attachment; filename="${attachment.name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(attachment.content).toString('base64')}\r\n`,
    );
  }
  return [...head, 'Content-Type: multipart/mixed; boundary="b1"', '', ...parts, '--b1--', ''].join('\r\n');
}

describe('Email Trigger (IMAP): items', () => {
  it('is a core poll trigger with an IMAP credential', () => {
    const node = corePlugin.nodes.find((n) => n.description.name === 'emailReadImap');
    expect(node?.description).toMatchObject({ kind: 'trigger', triggerSource: 'poll', displayName: 'Email Trigger (IMAP)', credentials: [{ name: 'imap', required: true }] });
    expect(node?.description.properties[0]).toMatchObject({ name: 'pollInterval', type: 'number', default: 60 });
    expect(corePlugin.credentialTypes?.some((c) => c.name === 'imap')).toBe(true);
    expect(imapCredential.properties.find((p) => p.name === 'password')?.typeOptions?.password).toBe(true);
  });

  it('maps from, to, subject, text, html, headers and attachments (as binary files)', async () => {
    const raw = mime({
      from: 'Ada Lovelace <ada@example.com>',
      to: 'ops@example.com, Bob <bob@example.com>',
      subject: 'Monthly report',
      text: 'See attached.',
      html: '<p>See <b>attached</b>.</p>',
      attachment: { name: 'report.csv', content: CSV },
      messageId: '<m1@example.com>',
    });
    const parsed = await simpleParser(raw);
    const helpers = { prepareBinaryData: async (data: unknown, fileName?: string, mimeType?: string) => hostBinaryClient('ex_imap_unit').write(data as Uint8Array, { fileName, mimeType }) };
    const item = await messageItem({ helpers } as never, 7, parsed, ['\\Recent'], { mailbox: 'INBOX', downloadAttachments: true, attachmentPrefix: 'attachment_' });
    expect(item.json).toMatchObject({
      uid: 7,
      mailbox: 'INBOX',
      messageId: '<m1@example.com>',
      date: '2026-10-24T10:00:00.000Z',
      subject: 'Monthly report',
      from: '"Ada Lovelace" <ada@example.com>',
      fromAddresses: [{ name: 'Ada Lovelace', address: 'ada@example.com' }],
      toAddresses: [{ name: '', address: 'ops@example.com' }, { name: 'Bob', address: 'bob@example.com' }],
      html: '<p>See <b>attached</b>.</p>',
      flags: ['\\Recent'],
      attachments: [{ fileName: 'report.csv', mimeType: 'text/csv', size: CSV.length, inline: false, binaryProperty: 'attachment_0' }],
    });
    expect(String(item.json.text).trim()).toBe('See attached.');
    expect((item.json.headers as JsonObject)['x-landflow-test']).toBe('yes');
    expect((item.json.headers as JsonObject).subject).toBe('Monthly report');
    const ref = item.binary?.attachment_0 as BinaryRef;
    expect(ref).toMatchObject({ fileName: 'report.csv', mimeType: 'text/csv' });
    expect(Buffer.from(await readAll((await store.open(ref.id!))!.stream)).toString()).toBe(CSV);

    const listed = await messageItem({ helpers } as never, 7, parsed, [], { mailbox: 'INBOX', downloadAttachments: false, attachmentPrefix: 'attachment_' });
    expect(listed.binary).toBeUndefined();
    expect((listed.json.attachments as JsonObject[])[0].binaryProperty).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Against GreenMail
// ---------------------------------------------------------------------------

/** A minimal SMTP client: enough to drop messages into GreenMail. */
async function sendMail(from: string, to: string, message: string) {
  const socket: Socket = connect(SMTP_PORT, HOST);
  socket.setEncoding('utf8');
  let buffer = '';
  const waiters: Array<(line: string) => void> = [];
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\r\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      if (/^\d{3} /.test(line)) waiters.shift()?.(line);
    }
  });
  const reply = () => new Promise<string>((resolve) => waiters.push(resolve));
  const command = async (text: string, expected: string) => {
    const pending = reply();
    socket.write(`${text}\r\n`);
    const line = await pending;
    if (!line.startsWith(expected)) throw new Error(`SMTP ${text.split(' ')[0]}: ${line}`);
  };
  const greeting = await reply();
  if (!greeting.startsWith('220')) throw new Error(`SMTP greeting: ${greeting}`);
  await command('EHLO landflow.test', '250');
  await command(`MAIL FROM:<${from}>`, '250');
  await command(`RCPT TO:<${to}>`, '250');
  await command('DATA', '354');
  await command(`${message.replace(/\r\n\./g, '\r\n..')}\r\n.`, '250');
  await command('QUIT', '221');
  socket.end();
}

describe.skipIf(!enabled)('Email Trigger (IMAP) against GreenMail', () => {
  const user = `inbox-${Date.now().toString(36)}@landflow.test`;
  const credential: ImapCredential = { user, password: 'any', host: HOST, port: IMAP_PORT, secure: false };
  let state: JsonObject | undefined;
  let counter = 0;

  const deliver = (subject: string, extra: Partial<Parameters<typeof mime>[0]> = {}) =>
    sendMail('sender@landflow.test', user, mime({ from: 'Sender <sender@landflow.test>', to: user, subject, text: `Body of ${subject}`, messageId: `<${subject.replace(/\W/g, '')}-${++counter}@landflow.test>`, ...extra }));

  async function poll(parameters: JsonObject = {}, mode: 'poll' | 'manual' = 'poll') {
    const request: ExecuteRequest = {
      protocol: 'landflow.plugin/v1',
      executionId: `ex_imap_${counter}`,
      workflowId: 'wf_imap',
      mode,
      node: { id: 'n1', name: 'Email Trigger (IMAP)', type: 'core.emailReadImap', typeVersion: 1 },
      parameters: { mailbox: 'INBOX', postProcessAction: 'read', downloadAttachments: true, ...parameters },
      itemParameters: [],
      inputs: [],
      credentials: { imap: credential as JsonObject },
      ...(state && { pollState: state }),
    };
    const response = await runNode(emailReadImapNode, request, { binary: hostBinaryClient(request.executionId) });
    if (response.error) throw new Error(`${response.error.message} ${response.error.description ?? ''}`);
    if (mode === 'poll') state = response.pollState;
    return response.outputs[0] ?? [];
  }

  async function mailbox(path: string) {
    const client = imapClient(credential);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(path);
      try {
        const messages = [];
        if ((client.mailbox && client.mailbox.exists) || 0) {
          for await (const message of client.fetch('1:*', { uid: true, flags: true, envelope: true })) messages.push({ uid: message.uid, subject: message.envelope?.subject, flags: [...(message.flags ?? [])] });
        }
        return messages;
      } finally {
        lock.release();
      }
    } finally {
      await closeQuietly(client);
    }
  }

  beforeAll(async () => {
    // Delivering creates the user and its INBOX.
    await deliver('Before publishing');
  }, 30_000);

  it('the credential test connects', async () => {
    expect(await imapCredential.test!(credential as JsonObject, {} as never)).toMatchObject({ ok: true });
    expect(await imapCredential.test!({ ...credential, port: 1 } as JsonObject, {} as never)).toMatchObject({ ok: false });
  });

  it('records a baseline first, then emits new messages oldest first and marks them read', async () => {
    expect(await poll()).toEqual([]);
    expect(state).toMatchObject({ lastUid: 1 });
    expect(typeof state?.uidValidity).toBe('string');

    await deliver('First');
    await deliver('Second', { html: '<p>Second</p>', attachment: { name: 'report.csv', content: CSV } });
    const items = await poll();
    expect(items.map((i) => i.json.subject)).toEqual(['First', 'Second']);
    expect(items[0].json).toMatchObject({ uid: 2, from: '"Sender" <sender@landflow.test>', to: user, html: '' });
    expect(String(items[0].json.text).trim()).toBe('Body of First');
    expect(items[1].json).toMatchObject({ uid: 3, html: '<p>Second</p>', attachments: [{ fileName: 'report.csv', binaryProperty: 'attachment_0' }] });
    const ref = items[1].binary?.attachment_0 as BinaryRef;
    expect(Buffer.from(await readAll((await store.open(ref.id!))!.stream)).toString()).toBe(CSV);
    expect(state).toMatchObject({ lastUid: 3 });

    const inbox = await mailbox('INBOX');
    expect(inbox.filter((m) => m.uid >= 2).every((m) => m.flags.includes('\\Seen'))).toBe(true);
    expect(inbox.find((m) => m.uid === 1)?.flags.includes('\\Seen')).toBe(false);
    expect(await poll()).toEqual([]);
  }, 30_000);

  it('moves processed messages to a folder it creates', async () => {
    await deliver('Third');
    const items = await poll({ postProcessAction: 'move', moveTo: 'Processed' });
    expect(items.map((i) => i.json.subject)).toEqual(['Third']);
    expect((await mailbox('INBOX')).some((m) => m.subject === 'Third')).toBe(false);
    expect((await mailbox('Processed')).map((m) => m.subject)).toEqual(['Third']);
  }, 30_000);

  it('a manual run shows the latest unread messages and changes nothing', async () => {
    await deliver('Fourth');
    const before = { ...state };
    const items = await poll({}, 'manual');
    expect(items.map((i) => i.json.subject)).toEqual(['Before publishing', 'Fourth']);
    expect(state).toEqual(before);
    expect((await mailbox('INBOX')).find((m) => m.subject === 'Fourth')?.flags.includes('\\Seen')).toBe(false);
    // The scheduled poll still emits it.
    expect((await poll({ postProcessAction: 'nothing' })).map((i) => i.json.subject)).toEqual(['Fourth']);
    expect((await mailbox('INBOX')).find((m) => m.subject === 'Fourth')?.flags.includes('\\Seen')).toBe(false);
  }, 30_000);

  it('IDLE: the server announces new mail on an open connection', async () => {
    const client = imapClient(credential, { autoIdleDelay: 300 });
    await client.connect();
    try {
      await client.mailboxOpen('INBOX', { readOnly: true });
      const announced = new Promise<{ count: number; prevCount: number }>((resolve) => client.on('exists', resolve));
      await new Promise((resolve) => setTimeout(resolve, 1_000)); // let auto-IDLE start
      await deliver('Pushed');
      const event = await Promise.race([announced, new Promise<never>((_, reject) => setTimeout(() => reject(new Error('no EXISTS within 10 s')), 10_000))]);
      expect(event.count).toBe(event.prevCount + 1);
    } finally {
      await closeQuietly(client);
    }
    expect((await poll()).map((i) => i.json.subject)).toEqual(['Pushed']);
  }, 30_000);
});
