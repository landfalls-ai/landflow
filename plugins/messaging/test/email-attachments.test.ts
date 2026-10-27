/** Send Email with files from item.binary: multipart/mixed attachments and inline (Content-ID) images. */
import { afterEach, describe, expect, it } from 'vitest';
import { runNode, type JsonObject } from '@landflow/sdk';
import type { BinaryRef } from '@landflow/protocol';
import { plugin } from '../src/main';
import { EmailSend } from '../src/nodes/email-send';
import { buildMessage } from '../src/smtp';
import { startFakeSmtp, type FakeSmtp } from './fake-smtp';
import { executeRequest } from './helpers';

let server: FakeSmtp | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const PDF = Buffer.from('%PDF-1.4 ' + 'report line\n'.repeat(20));
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const inline = (bytes: Buffer, fileName: string, mimeType: string): BinaryRef => ({ mimeType, fileName, fileSize: bytes.length, data: bytes.toString('base64') });

async function send(parameters: JsonObject, binary?: Record<string, BinaryRef>) {
  server = await startFakeSmtp({});
  const request = executeRequest('emailSend', { fromEmail: 'bot@example.com', toEmail: 'ann@example.com', subject: 'Files', emailFormat: 'html', html: '<p>See <img src="cid:logo"></p>', ...parameters }, {
    credentials: { smtp: { host: '127.0.0.1', port: server.port, secure: false, user: '', password: '', disableStartTls: true, hostName: 'landflow.test' } },
  });
  request.inputs = [[{ json: {}, ...(binary && { binary }) }]];
  return runNode(EmailSend, request, { credentialTypes: plugin.credentialTypes, pluginId: 'messaging' });
}

/** Decode the base64 body of the part carrying `filename`. */
function partBytes(data: string, filename: string): Buffer {
  const part = data.split(/\r\n--[^\r\n]+/).find((p) => p.includes(`filename="${filename}"`))!;
  return Buffer.from(part.split('\r\n\r\n')[1].replace(/\s+/g, ''), 'base64');
}

describe('Send Email attachments', () => {
  it('attaches binary properties as multipart/mixed with their name and type', async () => {
    const response = await send({ options: { attachments: 'report, extra' } }, { report: inline(PDF, 'q3 report.pdf', 'application/pdf'), extra: inline(PNG, 'Grüße.png', 'image/png') });
    expect(response.error).toBeUndefined();
    const data = server!.mails[0].data;
    expect(data).toMatch(/Content-Type: multipart\/mixed; boundary="/);
    expect(data).toContain('Content-Type: application/pdf; name="q3 report.pdf"');
    expect(data).toContain('Content-Disposition: attachment; filename="q3 report.pdf"');
    expect(data).toContain('Content-Transfer-Encoding: base64');
    expect(partBytes(data, 'q3 report.pdf').equals(PDF)).toBe(true);
    expect(data).toContain('filename="=?UTF-8?B?');
    expect(data.split('\r\n').every((line) => line.length <= 998)).toBe(true);
  });

  it('embeds inline files by Content-ID in multipart/related, next to regular attachments', async () => {
    const response = await send({ options: { inlineFiles: 'logo', attachments: 'report' } }, { logo: inline(PNG, 'logo.png', 'image/png'), report: inline(PDF, 'r.pdf', 'application/pdf') });
    expect(response.error).toBeUndefined();
    const data = server!.mails[0].data;
    expect(data).toMatch(/Content-Type: multipart\/mixed;[\s\S]*Content-Type: multipart\/related;/);
    expect(data).toContain('Content-ID: <logo>');
    expect(data).toContain('Content-Disposition: inline; filename="logo.png"');
    expect(partBytes(data, 'logo.png').equals(PNG)).toBe(true);
    expect(partBytes(data, 'r.pdf').equals(PDF)).toBe(true);
  });

  it('names the missing property when the item has no such file, and sends no mail', async () => {
    const response = await send({ options: { attachments: 'nope' } }, { report: inline(PDF, 'r.pdf', 'application/pdf') });
    expect(response.error?.message).toMatch(/no binary file “nope”/);
    expect(server!.mails).toHaveLength(0);
  });

  it('builds a plain message unchanged when there are no attachments', () => {
    expect(buildMessage({ from: 'a@example.com', to: 'b@example.com', text: 'hi' }).raw).not.toContain('multipart');
  });
});
