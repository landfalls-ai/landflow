/** The SMTP client: message building, then real conversations with an in-process server (plain, STARTTLS, implicit TLS). */
import { X509Certificate } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildMessage,
  dotStuff,
  encodeHeaderValue,
  encodeQuotedPrintable,
  parseAddressList,
  sendMail,
  SmtpError,
  verifySmtp,
  type SmtpConfig,
} from '../src/smtp';
import { selfSignedCertificate } from './cert';
import { startFakeSmtp, type FakeSmtp, type FakeSmtpOptions } from './fake-smtp';

const AUTH = { user: 'mailer@example.com', password: 'test-password-123' };
const certificate = selfSignedCertificate();

let server: FakeSmtp | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(options: FakeSmtpOptions = {}) {
  server = await startFakeSmtp(options);
  return server;
}

const config = (port: number, extra: Partial<SmtpConfig> = {}): SmtpConfig => ({
  host: '127.0.0.1',
  port,
  secure: false,
  hostName: 'client.test',
  timeoutMs: 2000,
  ...extra,
});
const mail = { from: 'Landflow <bot@example.com>', to: 'ann@example.com', subject: 'Hello', text: 'Hi Ann' };

/** Header block of a raw message as a name → value map (unfolded). */
function headersOf(raw: string): Record<string, string> {
  const [head] = raw.split('\r\n\r\n');
  const out: Record<string, string> = {};
  for (const line of head.replace(/\r\n[ \t]/g, ' ').split('\r\n')) {
    const index = line.indexOf(':');
    out[line.slice(0, index)] = line.slice(index + 2);
  }
  return out;
}

describe('message building', () => {
  it('writes the standard headers, keeps BCC out and dedupes the envelope', () => {
    const message = buildMessage({
      from: 'Landflow Bot <bot@example.com>',
      to: 'ann@example.com, "Doe, John" <john@example.com>',
      cc: 'ann@example.com, Cara <cara@example.com>',
      bcc: 'boss@example.com',
      replyTo: 'support@example.com',
      subject: 'Report',
      text: 'Hi',
      date: new Date('2026-10-25T10:00:00Z'),
    });
    const headers = headersOf(message.raw);
    expect(headers).toMatchObject({
      From: 'Landflow Bot <bot@example.com>',
      To: 'ann@example.com, "Doe, John" <john@example.com>',
      Cc: 'ann@example.com, Cara <cara@example.com>',
      'Reply-To': 'support@example.com',
      Subject: 'Report',
      Date: 'Sun, 25 Oct 2026 10:00:00 +0000',
      'MIME-Version': '1.0',
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Transfer-Encoding': '7bit',
    });
    expect(headers.Bcc).toBeUndefined();
    expect(message.raw).not.toContain('boss@example.com');
    expect(headers['Message-ID']).toBe(message.messageId);
    expect(message.messageId).toMatch(/^<[0-9a-f]{24}\.[0-9a-z]+@example\.com>$/);
    expect(message.envelope).toEqual({ from: 'bot@example.com', to: ['ann@example.com', 'john@example.com', 'cara@example.com', 'boss@example.com'] });
  });

  it('encodes non-ASCII headers as RFC 2047 words and bodies as quoted-printable', () => {
    const message = buildMessage({ from: 'Jürgen Müller <j@example.com>', to: 'a@example.com', subject: 'Grüße aus Köln 🎉', text: 'Schöne Grüße' });
    const headers = headersOf(message.raw);
    expect(headers.From).toBe(`=?UTF-8?B?${Buffer.from('Jürgen Müller').toString('base64')}?= <j@example.com>`);
    expect(headers.Subject).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(Buffer.from(headers.Subject.slice(10, -2), 'base64').toString('utf8')).toBe('Grüße aus Köln 🎉');
    expect(headers['Content-Transfer-Encoding']).toBe('quoted-printable');
    expect(message.raw.endsWith('Sch=C3=B6ne Gr=C3=BC=C3=9Fe')).toBe(true);
  });

  it('splits long encoded subjects into words of at most 75 characters without breaking characters', () => {
    const subject = 'Ünïcödé '.repeat(20);
    const encoded = encodeHeaderValue(subject);
    const words = encoded.split(' ');
    expect(words.length).toBeGreaterThan(1);
    for (const word of words) expect(word.length).toBeLessThanOrEqual(75);
    expect(words.map((w) => Buffer.from(w.slice(10, -2), 'base64').toString('utf8')).join('')).toBe(subject);
    // folded header lines stay short
    for (const line of buildMessage({ from: 'a@example.com', to: 'b@example.com', subject }).raw.split('\r\n\r\n')[0].split('\r\n'))
      expect(line.length).toBeLessThanOrEqual(78);
  });

  it('builds multipart/alternative for text + html', () => {
    const message = buildMessage({ from: 'a@example.com', to: 'b@example.com', text: 'plain', html: '<p>rich</p>' });
    const type = headersOf(message.raw)['Content-Type'];
    const boundary = /boundary="([^"]+)"/.exec(type)![1];
    expect(type).toMatch(/^multipart\/alternative; /);
    const body = message.raw.split('\r\n\r\n').slice(1).join('\r\n\r\n');
    expect(body).toBe(
      `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\nplain\r\n` +
        `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 7bit\r\n\r\n<p>rich</p>\r\n--${boundary}--\r\n`,
    );
  });

  it('dot-stuffs lines that start with a dot and terminates the data', () => {
    expect(dotStuff('.hidden\r\nline\r\n.\r\n..two')).toBe('..hidden\r\nline\r\n..\r\n...two\r\n.\r\n');
    expect(dotStuff('ends with crlf\r\n')).toBe('ends with crlf\r\n.\r\n');
  });

  it('quoted-printable: soft breaks at 76 characters, = and trailing spaces encoded', () => {
    const encoded = encodeQuotedPrintable(`${'a'.repeat(100)}=b \r\nx`);
    for (const line of encoded.split('\r\n')) expect(line.length).toBeLessThanOrEqual(76);
    expect(encoded).toBe(`${'a'.repeat(75)}=\r\n${'a'.repeat(25)}=3Db=20\r\nx`);
  });

  it('parses address lists and rejects bad addresses and header injection', () => {
    expect(parseAddressList('a@x.io; "Doe, J" <j@x.io>,  <k@x.io> ,')).toEqual([
      { address: 'a@x.io' },
      { name: 'Doe, J', address: 'j@x.io' },
      { address: 'k@x.io' },
    ]);
    expect(() => parseAddressList('not-an-address')).toThrow('"not-an-address" is not a valid email address');
    expect(() => buildMessage({ from: 'a@x.io, b@x.io', to: 'c@x.io' })).toThrow('From needs exactly one email address');
    expect(() => buildMessage({ from: 'a@x.io' })).toThrow('Add at least one recipient (To, CC or BCC)');
    const injected = buildMessage({ from: 'a@x.io', to: 'b@x.io', subject: 'Hi\r\nBcc: evil@x.io' });
    expect(headersOf(injected.raw).Subject).toBe('Hi Bcc: evil@x.io');
    expect(injected.raw).not.toMatch(/\r\nBcc:/);
  });
});

describe('SMTP conversation (plain)', () => {
  it('sends with AUTH PLAIN and reports accepted, rejected and the final reply', async () => {
    const smtp = await serve({ auth: AUTH, rejectRecipients: ['ghost@example.com'] });
    const result = await sendMail(config(smtp.port, AUTH), { ...mail, to: 'ann@example.com, ghost@example.com', text: '.leading dot\r\nsecond line' });
    expect(result).toEqual({
      messageId: expect.stringMatching(/@example\.com>$/),
      accepted: ['ann@example.com'],
      rejected: ['ghost@example.com'],
      response: '250 2.0.0 Ok: queued as FAKE123',
    });
    expect(smtp.commands).toEqual([
      'EHLO client.test',
      'AUTH PLAIN',
      'MAIL FROM:<bot@example.com>',
      'RCPT TO:<ann@example.com>',
      'RCPT TO:<ghost@example.com>',
      'DATA',
      'QUIT',
    ]);
    const [received] = smtp.mails;
    expect(received).toMatchObject({
      from: 'bot@example.com',
      to: ['ann@example.com'],
      user: AUTH.user,
      authMethod: 'PLAIN',
      secure: false,
      helo: 'client.test',
    });
    expect(received.wire).toContain('..leading dot'); // stuffed on the wire…
    expect(received.data).toContain('\r\n\r\n.leading dot\r\nsecond line'); // …and restored by the server
    expect(received.data).toContain(`Message-ID: ${result.messageId}`);
  });

  it('uses AUTH LOGIN when the server only offers LOGIN', async () => {
    const smtp = await serve({ auth: AUTH, authMethods: ['LOGIN'] });
    await sendMail(config(smtp.port, AUTH), mail);
    expect(smtp.mails[0].authMethod).toBe('LOGIN');
  });

  it("fails with the server's reply code on a wrong password", async () => {
    const smtp = await serve({ auth: AUTH });
    const error = await sendMail(config(smtp.port, { ...AUTH, password: 'wrong-password' }), mail).catch((e) => e);
    expect(error).toBeInstanceOf(SmtpError);
    expect(error).toMatchObject({ kind: 'reply', phase: 'AUTH', code: 535, message: 'SMTP AUTH PLAIN rejected: 535 5.7.8 Authentication credentials invalid' });
    expect(error.message).not.toContain('wrong-password');
  });

  it('fails when every recipient is rejected, and when login is required but not configured', async () => {
    const smtp = await serve({ auth: AUTH, rejectRecipients: ['ghost@example.com'] });
    const rejected = await sendMail(config(smtp.port, AUTH), { ...mail, to: 'ghost@example.com' }).catch((e) => e);
    expect(rejected).toMatchObject({
      phase: 'RCPT TO',
      code: 550,
      message: 'SMTP server rejected every recipient: 550 5.1.1 <ghost@example.com>: Recipient address rejected: User unknown',
    });
    const anonymous = await sendMail(config(smtp.port), mail).catch((e) => e);
    expect(anonymous).toMatchObject({ phase: 'MAIL FROM', code: 530, message: 'SMTP MAIL FROM rejected: 530 5.7.0 Authentication required' });
    expect(smtp.mails).toHaveLength(0);
  });

  it('falls back to HELO when EHLO is not supported', async () => {
    const smtp = await serve({ ehlo: false });
    await sendMail(config(smtp.port), mail);
    expect(smtp.commands.slice(0, 2)).toEqual(['EHLO client.test', 'HELO client.test']);
    expect(smtp.mails).toHaveLength(1);
  });

  it('times out when the server never greets, and reports refused connections', async () => {
    const smtp = await serve({ silent: true });
    const timeout = await sendMail(config(smtp.port, { timeoutMs: 200 }), mail).catch((e) => e);
    expect(timeout).toMatchObject({ kind: 'timeout', phase: 'greeting', message: 'No reply from the SMTP server within 0.2 s (greeting)' });
    const refused = await sendMail(config(1), mail).catch((e) => e);
    expect(refused).toMatchObject({ kind: 'network', phase: 'connect' });
    expect(refused.message).toMatch(/^Could not connect to 127\.0\.0\.1:1: connect ECONNREFUSED/);
  });

  it('verifies a connection: connect, EHLO, AUTH, QUIT', async () => {
    const smtp = await serve({ auth: AUTH });
    expect(await verifySmtp(config(smtp.port, AUTH))).toEqual({
      greeting: '220 fake.smtp ESMTP Landflow test server',
      capabilities: ['SIZE', '8BITMIME', 'AUTH', 'SMTPUTF8'],
      secure: false,
      authMethod: 'PLAIN',
    });
    expect(smtp.commands).toEqual(['EHLO client.test', 'AUTH PLAIN', 'QUIT']);
  });

  it('reports each phase to the phase runner (used for child spans)', async () => {
    const smtp = await serve({ auth: AUTH, tls: certificate });
    const phases: string[] = [];
    await sendMail(config(smtp.port, { ...AUTH, ca: certificate.cert }), mail, (phase, fn) => {
      phases.push(phase);
      return fn();
    });
    expect(phases).toEqual(['connect', 'ehlo', 'starttls', 'auth', 'envelope', 'data', 'quit']);
  });
});

describe('SMTP over TLS (self-signed certificate generated with node:crypto)', () => {
  it('generates a valid certificate for localhost and 127.0.0.1', () => {
    const x509 = new X509Certificate(certificate.cert);
    expect(x509.subject).toBe('CN=localhost');
    expect(x509.subjectAltName).toBe('DNS:localhost, IP Address:127.0.0.1');
    expect(x509.checkIP('127.0.0.1')).toBe('127.0.0.1');
  });

  it('upgrades with STARTTLS, says EHLO again and authenticates inside TLS', async () => {
    const smtp = await serve({ auth: AUTH, tls: certificate });
    const result = await sendMail(config(smtp.port, { ...AUTH, ca: certificate.cert }), mail);
    expect(result.accepted).toEqual(['ann@example.com']);
    expect(smtp.commands.slice(0, 4)).toEqual(['EHLO client.test', 'STARTTLS', 'EHLO client.test', 'AUTH PLAIN']);
    expect(smtp.mails[0]).toMatchObject({ secure: true, user: AUTH.user });
  });

  it('rejects an untrusted certificate unless told to ignore it', async () => {
    const smtp = await serve({ tls: certificate });
    const error = await sendMail(config(smtp.port), mail).catch((e) => e);
    expect(error).toMatchObject({ kind: 'tls', phase: 'STARTTLS' });
    expect(error.message).toMatch(/^TLS error with 127\.0\.0\.1:\d+: self[- ]signed certificate/);
    await sendMail(config(smtp.port, { rejectUnauthorized: false }), mail);
    expect(smtp.mails[0].secure).toBe(true);
  });

  it('stays plain with Disable STARTTLS', async () => {
    const smtp = await serve({ tls: certificate });
    await sendMail(config(smtp.port, { disableStartTls: true }), mail);
    expect(smtp.commands).not.toContain('STARTTLS');
    expect(smtp.mails[0].secure).toBe(false);
  });

  it('speaks implicit TLS (port 465 style) with secure: true', async () => {
    const smtp = await serve({ auth: AUTH, tls: certificate, implicitTls: true });
    const session = await verifySmtp(config(smtp.port, { ...AUTH, secure: true, ca: certificate.cert }));
    expect(session).toMatchObject({ secure: true, authMethod: 'PLAIN' });
    expect(smtp.commands).not.toContain('STARTTLS');
  });

  it('explains a TLS client talking to a plain server', async () => {
    const smtp = await serve();
    const error = await sendMail(config(smtp.port, { secure: true, rejectUnauthorized: false }), mail).catch((e) => e);
    expect(error).toMatchObject({ kind: 'tls' });
    expect(error.message).toMatch(/wrong version number|packet length too long|SSL/i);
  });
});
