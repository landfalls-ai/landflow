/**
 * Email for invites and password resets, over SMTP with a small built-in client (EHLO, STARTTLS when offered,
 * AUTH PLAIN/LOGIN, one message per connection). Configured with LANDFLOW_SMTP_HOST, LANDFLOW_SMTP_PORT (587;
 * 465 means TLS from the start, as does LANDFLOW_SMTP_SECURE=true), LANDFLOW_SMTP_USER, LANDFLOW_SMTP_PASS and
 * LANDFLOW_SMTP_FROM. Without a host, nothing is sent and the UI shows the link to copy instead.
 * Tests swap the transport with `setMailTransport`.
 */
import { randomBytes } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket } from 'node:tls';
import { singleton } from '../singleton';
import { logger } from '../telemetry';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface MailTransport {
  send(message: MailMessage & { from: string }): Promise<void>;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  /** LANDFLOW_SMTP_IGNORE_TLS=true: don't upgrade with STARTTLS even when offered. */
  ignoreTls: boolean;
}

export function smtpConfig(): SmtpConfig | undefined {
  const host = process.env.LANDFLOW_SMTP_HOST?.trim();
  if (!host) return undefined;
  const port = Number(process.env.LANDFLOW_SMTP_PORT) || 587;
  return {
    host,
    port,
    secure: process.env.LANDFLOW_SMTP_SECURE ? process.env.LANDFLOW_SMTP_SECURE === 'true' : port === 465,
    ...(process.env.LANDFLOW_SMTP_USER && { user: process.env.LANDFLOW_SMTP_USER, pass: process.env.LANDFLOW_SMTP_PASS ?? '' }),
    from: process.env.LANDFLOW_SMTP_FROM?.trim() || `Landflow <landflow@${host === '127.0.0.1' || host === 'localhost' ? 'localhost' : host}>`,
    ignoreTls: process.env.LANDFLOW_SMTP_IGNORE_TLS === 'true',
  };
}

const override = () => singleton<{ transport?: MailTransport }>('mail-transport', () => ({}));

/** Tests: send through `transport` instead of SMTP (undefined restores SMTP). */
export function setMailTransport(transport: MailTransport | undefined) {
  override().transport = transport;
}

/** Whether invites and resets can go out by email. */
export function mailConfigured(): boolean {
  return Boolean(override().transport || smtpConfig());
}

/** Send a message. Throws when sending fails or nothing is configured. */
export async function sendMail(message: MailMessage): Promise<void> {
  const config = smtpConfig();
  const transport = override().transport ?? (config && smtpTransport(config));
  if (!transport) throw new Error('Email is not configured (LANDFLOW_SMTP_HOST)');
  await transport.send({ ...message, from: config?.from ?? 'Landflow <landflow@localhost>' });
  logger.info('email sent', { 'landflow.mail.subject': message.subject });
}

// ---- SMTP -------------------------------------------------------------------

/** The bare address of `Name <address>` (or the string itself). */
export function addressOf(value: string): string {
  return /<([^>]+)>/.exec(value)?.[1]?.trim() ?? value.trim();
}

const encodeHeader = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString('base64')}?=`);

/** The message as RFC 5322 text (CRLF lines, dot-stuffed for DATA). */
export function buildMessage(message: MailMessage & { from: string }, now = new Date()): string {
  const boundary = `lf-${randomBytes(12).toString('hex')}`;
  const domain = addressOf(message.from).split('@')[1] ?? 'localhost';
  const base64 = (text: string) => (Buffer.from(text).toString('base64').match(/.{1,76}/g) ?? []).join('\r\n');
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeader(message.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
  ];
  const body = message.html
    ? [
        `Content-Type: multipart/alternative; boundary="${boundary}"`,
        '',
        `--${boundary}`,
        'Content-Type: text/plain; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64(message.text),
        `--${boundary}`,
        'Content-Type: text/html; charset=utf-8',
        'Content-Transfer-Encoding: base64',
        '',
        base64(message.html),
        `--${boundary}--`,
      ]
    : ['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64(message.text)];
  return [...headers, ...body].join('\r\n').replace(/^\./gm, '..');
}

/** Reads SMTP replies (multi-line ones end with `<code> `). */
class SmtpConnection {
  private buffer = '';
  private waiting?: { resolve: (reply: { code: number; text: string }) => void; reject: (error: Error) => void };
  private failure?: Error;
  private readonly onData = (chunk: Buffer) => {
    this.buffer += chunk.toString('utf8');
    this.drain();
  };
  private readonly onError = (error: Error) => this.fail(error);
  private readonly onClose = () => this.fail(new Error('The SMTP server closed the connection'));

  constructor(public socket: Socket | TLSSocket) {
    this.attach(socket);
  }

  private attach(socket: Socket | TLSSocket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  /** STARTTLS accepted: continue over TLS on the same connection. */
  async upgrade(servername: string) {
    const raw = this.socket;
    raw.off('data', this.onData);
    raw.off('error', this.onError);
    raw.off('close', this.onClose);
    this.buffer = '';
    const secured = await new Promise<TLSSocket>((resolve, reject) => {
      const tls = tlsConnect({ socket: raw, servername }, () => resolve(tls));
      tls.once('error', reject);
    });
    this.attach(secured);
  }

  private fail(error: Error) {
    this.failure ??= error;
    this.waiting?.reject(error);
    this.waiting = undefined;
  }

  private drain() {
    if (!this.waiting) return;
    const lines = this.buffer.split('\r\n');
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i])) {
        const text = lines.slice(0, i + 1).join('\n');
        this.buffer = lines.slice(i + 1).join('\r\n');
        const waiting = this.waiting;
        this.waiting = undefined;
        waiting.resolve({ code: Number(lines[i].slice(0, 3)), text });
        return;
      }
    }
  }

  read(): Promise<{ code: number; text: string }> {
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
      this.drain();
    });
  }

  async command(line: string | undefined, expect: number[]): Promise<string> {
    if (line !== undefined) this.socket.write(`${line}\r\n`);
    const reply = await this.read();
    if (!expect.includes(reply.code)) throw new Error(`SMTP ${line?.split(' ')[0] ?? 'greeting'} failed: ${reply.text.replace(/\n/g, ' ')}`);
    return reply.text;
  }
}

function open(config: SmtpConfig, timeoutMs: number): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host }, () => resolve(socket))
      : netConnect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`SMTP ${config.host}:${config.port} timed out`)));
    socket.once('error', reject);
  });
}

export function smtpTransport(config: SmtpConfig, timeoutMs = 15_000): MailTransport {
  return {
    async send(message) {
      const socket = await open(config, timeoutMs);
      const smtp = new SmtpConnection(socket);
      const name = 'landflow.local';
      try {
        await smtp.command(undefined, [220]);
        let features = await smtp.command(`EHLO ${name}`, [250]);
        if (!config.secure && !config.ignoreTls && /STARTTLS/i.test(features)) {
          await smtp.command('STARTTLS', [220]);
          await smtp.upgrade(config.host);
          features = await smtp.command(`EHLO ${name}`, [250]);
        }
        if (config.user) {
          if (/AUTH[^\n]*PLAIN/i.test(features)) {
            await smtp.command(`AUTH PLAIN ${Buffer.from(`\0${config.user}\0${config.pass ?? ''}`).toString('base64')}`, [235]);
          } else {
            await smtp.command('AUTH LOGIN', [334]);
            await smtp.command(Buffer.from(config.user).toString('base64'), [334]);
            await smtp.command(Buffer.from(config.pass ?? '').toString('base64'), [235]);
          }
        }
        await smtp.command(`MAIL FROM:<${addressOf(message.from)}>`, [250]);
        await smtp.command(`RCPT TO:<${addressOf(message.to)}>`, [250, 251]);
        await smtp.command('DATA', [354]);
        await smtp.command(`${buildMessage(message)}\r\n.`, [250]);
        await smtp.command('QUIT', [221]).catch(() => {});
      } finally {
        smtp.socket.destroy();
      }
    },
  };
}

// ---- messages ---------------------------------------------------------------

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function layout(title: string, lines: string[], action: { label: string; url: string }, footer: string): { text: string; html: string } {
  const text = [...lines, '', `${action.label}: ${action.url}`, '', footer].join('\n');
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1c1c1a">
<div style="max-width:480px;margin:0 auto;background:#fff;border:1px solid #e6e6e1;border-radius:16px;padding:28px">
<div style="font-weight:700;font-size:13px;letter-spacing:.02em;color:#555">LANDFLOW</div>
<h1 style="font-size:18px;margin:14px 0 10px">${escapeHtml(title)}</h1>
${lines.map((line) => `<p style="font-size:14px;line-height:1.55;margin:0 0 10px">${escapeHtml(line)}</p>`).join('\n')}
<p style="margin:20px 0"><a href="${escapeHtml(action.url)}" style="display:inline-block;background:#1c1c1a;color:#fff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 18px;border-radius:999px">${escapeHtml(action.label)}</a></p>
<p style="font-size:12px;line-height:1.5;color:#777;margin:0">${escapeHtml(footer)}<br>${escapeHtml(action.url)}</p>
</div></body></html>`;
  return { text, html };
}

export function inviteMessage(input: { to: string; link: string; invitedBy?: string; role: string }): MailMessage {
  const who = input.invitedBy ? `${input.invitedBy} invited you` : 'You are invited';
  const body = layout(
    'Join Landflow',
    [`${who} to Landflow as ${input.role === 'admin' ? 'an admin' : 'a member'}.`, 'Set your name and a password to finish creating your account.'],
    { label: 'Accept invite', url: input.link },
    'The link works once and expires in 7 days.',
  );
  return { to: input.to, subject: 'You are invited to Landflow', ...body };
}

export function resetMessage(input: { to: string; link: string }): MailMessage {
  const body = layout(
    'Reset your password',
    ['Someone asked to reset the password of your Landflow account. If it was you, choose a new password with the link below.', 'If it wasn’t, ignore this email.'],
    { label: 'Choose a new password', url: input.link },
    'The link works once and expires in an hour.',
  );
  return { to: input.to, subject: 'Reset your Landflow password', ...body };
}
