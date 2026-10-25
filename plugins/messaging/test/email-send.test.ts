/** Send Email node and the smtp credential against the in-process SMTP server. */
import { afterEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@landflow/sdk';
import { EmailSend } from '../src/nodes/email-send';
import { selfSignedCertificate } from './cert';
import { startFakeSmtp, type FakeSmtp, type FakeSmtpOptions } from './fake-smtp';
import { jsonOf, run, testCredentials } from './helpers';

const AUTH = { user: 'mailer@example.com', password: 'test-password-123' };
const certificate = selfSignedCertificate();

let server: FakeSmtp | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(options: FakeSmtpOptions = {}) {
  server = await startFakeSmtp({ auth: AUTH, ...options });
  return server;
}

const smtpCredential = (port: number, extra: JsonObject = {}): JsonObject => ({
  host: '127.0.0.1',
  port,
  secure: false,
  user: AUTH.user,
  password: AUTH.password,
  disableStartTls: false,
  hostName: 'landflow.test',
  ...extra,
});

const send = (port: number, parameters: JsonObject, extra: JsonObject = {}) =>
  run(
    EmailSend,
    { fromEmail: 'Landflow <bot@example.com>', toEmail: 'ann@example.com', subject: 'Hi', emailFormat: 'text', text: 'Hello', ...parameters },
    {
      credentials: { smtp: smtpCredential(port, extra) },
    },
  );

describe('Send Email', () => {
  it('sends and returns messageId, accepted, rejected and the server response', async () => {
    const smtp = await serve({ rejectRecipients: ['ghost@example.com'] });
    const response = await send(smtp.port, {
      toEmail: 'ann@example.com, ghost@example.com',
      options: { ccEmail: 'Cara <cara@example.com>', bccEmail: 'boss@example.com', replyTo: 'help@example.com' },
    });
    expect(response.error).toBeUndefined();
    const [out] = jsonOf(response);
    expect(out).toEqual({
      messageId: expect.stringMatching(/^<.+@example\.com>$/),
      accepted: ['ann@example.com', 'cara@example.com', 'boss@example.com'],
      rejected: ['ghost@example.com'],
      response: '250 2.0.0 Ok: queued as FAKE123',
    });
    expect(response.outputs[0][0].pairedItem).toEqual({ item: 0 });
    const [received] = smtp.mails;
    expect(received).toMatchObject({ from: 'bot@example.com', helo: 'landflow.test', user: AUTH.user });
    expect(received.data).toMatch(/^From: Landflow <bot@example\.com>\r\n/);
    expect(received.data).toContain('\r\nCc: Cara <cara@example.com>\r\n');
    expect(received.data).toContain('\r\nReply-To: help@example.com\r\n');
    expect(received.data).not.toContain('boss@example.com');
    expect(received.data).toContain('Content-Type: text/plain; charset=utf-8');
  });

  it('sends HTML only, or both as multipart/alternative', async () => {
    const smtp = await serve();
    await send(smtp.port, { emailFormat: 'html', html: '<b>Hi</b>', text: 'ignored' });
    expect(smtp.mails[0].data).toContain('Content-Type: text/html; charset=utf-8');
    expect(smtp.mails[0].data).not.toContain('ignored');
    await send(smtp.port, { emailFormat: 'both', html: '<b>Hi</b>', text: 'Hi' });
    expect(smtp.mails[1].data).toMatch(/Content-Type: multipart\/alternative; boundary="/);
    expect(smtp.mails[1].data).toContain('Content-Type: text/plain; charset=utf-8');
    expect(smtp.mails[1].data).toContain('<b>Hi</b>');
  });

  it('sends one email per item with per-item parameters', async () => {
    const smtp = await serve();
    const response = await run(
      EmailSend,
      { fromEmail: 'bot@example.com', toEmail: 'x@example.com', subject: 's', emailFormat: 'text', text: 't' },
      { credentials: { smtp: smtpCredential(smtp.port) }, items: [{}, {}], perItem: [{ toEmail: 'a@example.com' }, { toEmail: 'b@example.com' }] },
    );
    expect(smtp.mails.map((m) => m.to)).toEqual([['a@example.com'], ['b@example.com']]);
    expect(response.outputs[0].map((i) => i.pairedItem)).toEqual([{ item: 0 }, { item: 1 }]);
  });

  it('uses STARTTLS, and "Ignore SSL Issues" accepts a self-signed certificate', async () => {
    const smtp = await serve({ tls: certificate });
    const strict = await send(smtp.port, {});
    expect(strict.error?.message).toMatch(/^TLS error with 127\.0\.0\.1:\d+: self[- ]signed certificate/);
    expect(strict.error?.description).toMatch(/Ignore SSL Issues/);
    const relaxed = await send(smtp.port, { options: { allowUnauthorizedCerts: true } });
    expect(relaxed.error).toBeUndefined();
    expect(smtp.mails[0].secure).toBe(true);
  });

  it("maps SMTP failures to node errors with the server's reply and a hint, never the password", async () => {
    const smtp = await serve();
    const response = await send(smtp.port, {}, { password: 'wrong-password-999' });
    expect(response.error).toMatchObject({ message: 'SMTP AUTH PLAIN rejected: 535 5.7.8 Authentication credentials invalid', itemIndex: 0 });
    expect(response.error?.description).toMatch(/app password/);
    expect(JSON.stringify(response)).not.toContain('wrong-password-999');
    const badAddress = await send(smtp.port, { toEmail: 'nobody' });
    expect(badAddress.error?.message).toBe('"nobody" is not a valid email address');
    const missingFrom = await send(smtp.port, { fromEmail: '' });
    expect(missingFrom.error?.message).toBe('From Email is required');
  });

  it('explains a closed port', async () => {
    const response = await send(1, {});
    expect(response.error?.message).toMatch(/^Could not connect to 127\.0\.0\.1:1/);
    expect(response.error?.description).toBe('Nothing answered on 127.0.0.1:1. Check the host and port.');
  });
});

describe('smtp credential', () => {
  it('connects, says EHLO, authenticates and quits', async () => {
    const smtp = await serve();
    expect(await testCredentials('smtp', smtpCredential(smtp.port))).toEqual({
      ok: true,
      message: `Connected to 127.0.0.1:${smtp.port} (unencrypted, AUTH PLAIN accepted)`,
    });
    expect(smtp.commands).toEqual(['EHLO landflow.test', 'AUTH PLAIN', 'QUIT']);
  });

  it('explains an untrusted certificate after STARTTLS', async () => {
    const smtp = await serve({ tls: certificate });
    const result = await testCredentials('smtp', smtpCredential(smtp.port));
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/self[- ]signed certificate.*Ignore SSL Issues/);
  });

  it("returns the server's reason on a failed login", async () => {
    const smtp = await serve();
    expect(await testCredentials('smtp', smtpCredential(smtp.port, { password: 'nope-nope' }))).toEqual({
      ok: false,
      message:
        'SMTP AUTH PLAIN rejected: 535 5.7.8 Authentication credentials invalid. The server rejected the user name or password. Gmail, Outlook and others need an app password instead of the account password.',
    });
    expect(await testCredentials('smtp', { host: '', port: 25 })).toEqual({ ok: false, message: 'The SMTP credential has no host' });
  });
});
