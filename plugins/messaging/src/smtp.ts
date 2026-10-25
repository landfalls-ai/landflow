/**
 * A small SMTP client over node:net / node:tls, enough for "Send Email":
 * implicit TLS or STARTTLS, AUTH PLAIN and LOGIN, multi-line replies,
 * dot-stuffing, RFC 2047 encoded headers, multipart/alternative and a
 * Message-ID. No attachments, pipelining or DSN.
 *
 *   const result = await sendMail({ host, port: 465, secure: true, user, password }, { from, to, subject, text });
 *   // { messageId, accepted, rejected, response: '250 2.0.0 OK queued' }
 */
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { hostname } from 'node:os';
import { StringDecoder } from 'node:string_decoder';
import tls from 'node:tls';

export interface SmtpConfig {
  host: string;
  port: number;
  /** TLS from the first byte (port 465). Otherwise plain, upgraded with STARTTLS when the server offers it. */
  secure: boolean;
  user?: string;
  password?: string;
  /** Never upgrade a plain connection, even when the server offers STARTTLS. */
  disableStartTls?: boolean;
  /** Name sent with EHLO / HELO (default: this machine's host name). */
  hostName?: string;
  /** Verify the server certificate (default true). */
  rejectUnauthorized?: boolean;
  /** Extra trusted CA certificates (PEM): private CAs and tests. */
  ca?: string | string[];
  /** How long to wait for the connection, the TLS handshake and each reply (default 30 s). */
  timeoutMs?: number;
}

export interface SmtpReply {
  code: number;
  lines: string[];
}

/** What went wrong: a reply with an error code, no reply in time, a socket or TLS failure, or a reply we can't use. */
export type SmtpErrorKind = 'reply' | 'timeout' | 'network' | 'tls' | 'protocol';

export class SmtpError extends Error {
  constructor(
    message: string,
    readonly kind: SmtpErrorKind,
    /** The step that failed: greeting, EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA… */
    readonly phase: string,
    readonly reply?: SmtpReply,
  ) {
    super(message);
    this.name = 'SmtpError';
  }

  get code(): number | undefined {
    return this.reply?.code;
  }
}

export const replyText = (reply: SmtpReply) => `${reply.code} ${reply.lines.join(' ').trim()}`.trim();

/** Wraps each step, e.g. in a child span: `(phase, fn) => ctx.span(`smtp.${phase}`, fn)`. */
export type PhaseRunner = <T>(phase: string, fn: () => Promise<T>) => Promise<T>;
const direct: PhaseRunner = (_phase, fn) => fn();

const DEFAULT_TIMEOUT_MS = 30_000;
const TLS_ERROR = /SSL|TLS|CERT|self[- ]signed|certificate|wrong version number|altnames/i;

/** SNI must be a host name, never an IP literal. */
const serverName = (host: string) => (net.isIP(host) ? undefined : host);

function defaultClientName(): string {
  const name = hostname();
  return /^[A-Za-z0-9.-]+$/.test(name) ? name : '[127.0.0.1]';
}

/** One SMTP connection: a line reader that assembles (multi-line) replies, and command helpers. */
class SmtpConnection {
  private socket!: net.Socket;
  private decoder = new StringDecoder('utf8');
  private buffer = '';
  private partial: string[] = [];
  private replies: SmtpReply[] = [];
  private waiter?: { resolve: (reply: SmtpReply) => void; reject: (error: Error) => void };
  private failure?: Error;
  /** The current step, for error messages. */
  phase = 'connect';
  greeting = '';
  secure: boolean;
  private readonly timeoutMs: number;

  private constructor(
    socket: net.Socket,
    private readonly config: SmtpConfig,
  ) {
    this.secure = config.secure;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.attach(socket);
  }

  /** Connect (TLS right away when `secure`) and read the 220 greeting. */
  static async open(config: SmtpConfig): Promise<SmtpConnection> {
    const tlsOptions = { rejectUnauthorized: config.rejectUnauthorized !== false, ...(config.ca && { ca: config.ca }) };
    const socket = config.secure
      ? tls.connect({ host: config.host, port: config.port, servername: serverName(config.host), ...tlsOptions })
      : net.connect({ host: config.host, port: config.port });
    const connection = new SmtpConnection(socket, config);
    try {
      await connection.connected(socket, config.secure ? 'secureConnect' : 'connect');
      connection.phase = 'greeting';
      const greeting = await connection.read();
      if (greeting.code !== 220) throw new SmtpError(`The SMTP server refused the connection: ${replyText(greeting)}`, 'reply', 'greeting', greeting);
      connection.greeting = replyText(greeting);
      return connection;
    } catch (error) {
      connection.destroy();
      throw error;
    }
  }

  private readonly onData = (chunk: Buffer) => {
    this.buffer += this.decoder.write(chunk);
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      this.onLine(line);
    }
  };
  private readonly onError = (error: Error) => this.fail(this.socketError(error));
  private readonly onClose = () => this.fail(new SmtpError(`The SMTP server closed the connection (${this.phase})`, 'network', this.phase));

  private attach(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  private detach() {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  /** "250-SIZE 1000" continues a reply, "250 OK" ends it. */
  private onLine(line: string) {
    const match = /^(\d{3})([ -]?)(.*)$/.exec(line);
    if (!match) {
      this.fail(new SmtpError(`Unexpected line from the SMTP server: ${line.slice(0, 120)}`, 'protocol', this.phase));
      this.socket.destroy();
      return;
    }
    this.partial.push(match[3]);
    if (match[2] === '-') return;
    const reply: SmtpReply = { code: Number(match[1]), lines: this.partial };
    this.partial = [];
    if (this.waiter) this.waiter.resolve(reply);
    else this.replies.push(reply);
  }

  private fail(error: Error) {
    if (this.failure) return;
    this.failure = error;
    this.waiter?.reject(error);
  }

  private socketError(error: Error & { code?: string }): SmtpError {
    const where = `${this.config.host}:${this.config.port}`;
    if (TLS_ERROR.test(`${error.code ?? ''} ${error.message}`)) return new SmtpError(`TLS error with ${where}: ${error.message}`, 'tls', this.phase);
    if (this.phase === 'connect') return new SmtpError(`Could not connect to ${where}: ${error.message}`, 'network', this.phase);
    return new SmtpError(`Connection to ${where} failed (${this.phase}): ${error.message}`, 'network', this.phase);
  }

  /** Wait for `connect` / `secureConnect`; socket errors arrive through onError → fail. */
  private connected(socket: net.Socket, event: 'connect' | 'secureConnect'): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        done();
        const error = new SmtpError(`Timed out connecting to ${this.config.host}:${this.config.port} after ${this.timeoutMs / 1000} s`, 'timeout', this.phase);
        this.fail(error);
        reject(error);
      }, this.timeoutMs);
      const ok = () => {
        done();
        resolve();
      };
      const failed = () => {
        done();
        reject(this.failure ?? new SmtpError(`Could not connect to ${this.config.host}:${this.config.port}`, 'network', this.phase));
      };
      const done = () => {
        clearTimeout(timer);
        socket.off(event, ok);
        socket.off('error', failed);
        socket.off('close', failed);
      };
      socket.once(event, ok);
      // Registered after onError/onClose, so this.failure is already set when these run.
      socket.once('error', failed);
      socket.once('close', failed);
    });
  }

  /** The next complete reply. */
  read(timeoutMs = this.timeoutMs): Promise<SmtpReply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = undefined;
        const error = new SmtpError(`No reply from the SMTP server within ${timeoutMs / 1000} s (${this.phase})`, 'timeout', this.phase);
        this.fail(error);
        this.socket.destroy();
        reject(error);
      }, timeoutMs);
      this.waiter = {
        resolve: (reply) => {
          clearTimeout(timer);
          this.waiter = undefined;
          resolve(reply);
        },
        reject: (error) => {
          clearTimeout(timer);
          this.waiter = undefined;
          reject(error);
        },
      };
    });
  }

  write(data: string) {
    if (this.failure) throw this.failure;
    this.socket.write(data);
  }

  /** Send a command and return its reply, whatever the code. */
  async request(line: string, timeoutMs?: number): Promise<SmtpReply> {
    this.write(`${line}\r\n`);
    return this.read(timeoutMs);
  }

  /** Read a reply and require one of `codes`. `what` names the step in the error (never the command, which may hold credentials). */
  async expect(codes: number[], what: string): Promise<SmtpReply> {
    const reply = await this.read();
    if (!codes.includes(reply.code)) throw new SmtpError(`SMTP ${what} rejected: ${replyText(reply)}`, 'reply', this.phase, reply);
    return reply;
  }

  async command(line: string, codes: number[], what: string): Promise<SmtpReply> {
    this.write(`${line}\r\n`);
    return this.expect(codes, what);
  }

  /** EHLO, falling back to HELO for servers without ESMTP. Returns the capabilities: keyword → parameters. */
  async hello(name: string): Promise<Map<string, string[]>> {
    this.phase = 'EHLO';
    const reply = await this.request(`EHLO ${name}`);
    if (reply.code === 250) {
      const capabilities = new Map<string, string[]>();
      for (const line of reply.lines.slice(1)) {
        const [keyword, ...params] = line
          .trim()
          .replace(/^AUTH=/i, 'AUTH ')
          .split(/\s+/);
        if (keyword)
          capabilities.set(
            keyword.toUpperCase(),
            params.map((p) => p.toUpperCase()),
          );
      }
      return capabilities;
    }
    if (reply.code >= 500) {
      this.phase = 'HELO';
      await this.command(`HELO ${name}`, [250], 'HELO');
      return new Map();
    }
    throw new SmtpError(`SMTP EHLO rejected: ${replyText(reply)}`, 'reply', this.phase, reply);
  }

  /** Upgrade the plain socket in place (after the server's 220 to STARTTLS). */
  async startTls(): Promise<void> {
    const raw = this.socket;
    this.detach();
    raw.on('error', () => {}); // surfaces on the TLS socket
    const secure = tls.connect({
      socket: raw,
      host: this.config.host,
      servername: serverName(this.config.host),
      rejectUnauthorized: this.config.rejectUnauthorized !== false,
      ...(this.config.ca && { ca: this.config.ca }),
    });
    this.attach(secure);
    await this.connected(secure, 'secureConnect');
    this.secure = true;
  }

  async auth(user: string, password: string, capabilities: Map<string, string[]>): Promise<string> {
    this.phase = 'AUTH';
    const offered = capabilities.get('AUTH') ?? [];
    const b64 = (value: string) => Buffer.from(value, 'utf8').toString('base64');
    if (offered.length && !offered.includes('PLAIN') && !offered.includes('LOGIN')) {
      throw new SmtpError(`The SMTP server offers AUTH ${offered.join(' ')}; this client supports PLAIN and LOGIN`, 'protocol', this.phase);
    }
    if (!offered.includes('PLAIN') && offered.includes('LOGIN')) {
      await this.command('AUTH LOGIN', [334], 'AUTH LOGIN');
      await this.command(b64(user), [334], 'AUTH LOGIN');
      await this.command(b64(password), [235], 'AUTH LOGIN');
      return 'LOGIN';
    }
    // Servers that advertise nothing get PLAIN, the most widely supported mechanism.
    await this.command(`AUTH PLAIN ${b64(`\0${user}\0${password}`)}`, [235], 'AUTH PLAIN');
    return 'PLAIN';
  }

  /** Polite goodbye; the message is already accepted, so a slow or odd answer doesn't matter. */
  async quit(): Promise<void> {
    this.phase = 'QUIT';
    try {
      await this.request('QUIT', Math.min(this.timeoutMs, 5_000));
    } catch {
      // ignored
    } finally {
      this.socket.end();
    }
  }

  destroy() {
    this.socket.destroy();
  }
}

export interface SmtpSession {
  greeting: string;
  capabilities: string[];
  secure: boolean;
  authMethod?: string;
}

/** Connect, EHLO, STARTTLS (+ EHLO again), AUTH. */
async function openSession(config: SmtpConfig, run: PhaseRunner) {
  const connection = await run('connect', () => SmtpConnection.open(config));
  try {
    const name = config.hostName?.trim() || defaultClientName();
    let capabilities = await run('ehlo', () => connection.hello(name));
    if (!config.secure && !config.disableStartTls && capabilities.has('STARTTLS')) {
      capabilities = await run('starttls', async () => {
        connection.phase = 'STARTTLS';
        await connection.command('STARTTLS', [220], 'STARTTLS');
        await connection.startTls();
        return connection.hello(name);
      });
    }
    let authMethod: string | undefined;
    if (config.user) authMethod = await run('auth', () => connection.auth(config.user!, config.password ?? '', capabilities));
    return { connection, capabilities, authMethod };
  } catch (error) {
    connection.destroy();
    throw error;
  }
}

/** The credential test: connect, EHLO, (STARTTLS), AUTH, QUIT. */
export async function verifySmtp(config: SmtpConfig, run: PhaseRunner = direct): Promise<SmtpSession> {
  const { connection, capabilities, authMethod } = await openSession(config, run);
  try {
    await run('quit', () => connection.quit());
    return { greeting: connection.greeting, capabilities: [...capabilities.keys()], secure: connection.secure, ...(authMethod && { authMethod }) };
  } finally {
    connection.destroy();
  }
}

export interface SendResult {
  messageId: string;
  accepted: string[];
  rejected: string[];
  /** The server's final reply to DATA, e.g. "250 2.0.0 OK: queued as 4F2A1". */
  response: string;
}

export async function sendMail(config: SmtpConfig, mail: MailOptions, run: PhaseRunner = direct): Promise<SendResult> {
  const message = buildMessage(mail, config.hostName);
  const { connection, capabilities } = await openSession(config, run);
  try {
    const { accepted, rejected } = await run('envelope', async () => {
      connection.phase = 'MAIL FROM';
      const international = /[^\x00-\x7f]/.test([message.envelope.from, ...message.envelope.to].join('')) && capabilities.has('SMTPUTF8');
      await connection.command(`MAIL FROM:<${message.envelope.from}>${international ? ' SMTPUTF8' : ''}`, [250], 'MAIL FROM');
      connection.phase = 'RCPT TO';
      const accepted: string[] = [];
      const rejected: string[] = [];
      let firstRejection: SmtpReply | undefined;
      for (const recipient of message.envelope.to) {
        const reply = await connection.request(`RCPT TO:<${recipient}>`);
        if (reply.code === 250 || reply.code === 251) accepted.push(recipient);
        else {
          rejected.push(recipient);
          firstRejection ??= reply;
        }
      }
      if (!accepted.length) throw new SmtpError(`SMTP server rejected every recipient: ${replyText(firstRejection!)}`, 'reply', 'RCPT TO', firstRejection);
      return { accepted, rejected };
    });
    const response = await run('data', async () => {
      connection.phase = 'DATA';
      await connection.command('DATA', [354], 'DATA');
      connection.write(dotStuff(message.raw));
      return replyText(await connection.expect([250], 'message'));
    });
    await run('quit', () => connection.quit());
    return { messageId: message.messageId, accepted, rejected, response };
  } finally {
    connection.destroy();
  }
}

// ---------------------------------------------------------------------------
// Message building
// ---------------------------------------------------------------------------

export interface MailOptions {
  /** One address: "jane@example.com" or "Jane Doe <jane@example.com>". */
  from: string;
  /** Comma-separated addresses, each optionally with a display name. */
  to?: string;
  cc?: string;
  /** Envelope only: never written into the headers. */
  bcc?: string;
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  date?: Date;
  messageId?: string;
}

export interface Address {
  name?: string;
  address: string;
}

export interface BuiltMessage {
  raw: string;
  messageId: string;
  envelope: { from: string; to: string[] };
}

/** Lines starting with "." get another "." (RFC 5321 §4.5.2), then the "<CRLF>.<CRLF>" terminator. */
export function dotStuff(raw: string): string {
  const stuffed = raw.replace(/(^|\r\n)\./g, '$1..');
  return `${stuffed}${stuffed.endsWith('\r\n') ? '' : '\r\n'}.\r\n`;
}

/** Split "a@x.com, Doe, Jane" — commas inside quotes or <> don't separate. */
export function parseAddressList(input: string | undefined): Address[] {
  if (!input?.trim()) return [];
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let angle = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted && c === '\\') {
      current += c + (input[++i] ?? '');
      continue;
    }
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '<') angle = true;
    else if (!quoted && c === '>') angle = false;
    if ((c === ',' || c === ';') && !quoted && !angle) {
      parts.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .map(parseAddress);
}

function parseAddress(text: string): Address {
  const match = /^(.*?)<([^<>]+)>\s*$/s.exec(text);
  let name = '';
  let address = text;
  if (match) {
    name = match[1]
      .trim()
      .replace(/^"(.*)"$/s, '$1')
      .replace(/\\(.)/g, '$1');
    address = match[2].trim();
  }
  if (!/^[^\s@<>()",;]+@[^\s@<>()",;]+$/.test(address)) throw new Error(`"${text}" is not a valid email address`);
  name = name.replace(/[\r\n]+/g, ' ').trim();
  return name ? { name, address } : { address };
}

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;

/** RFC 2047 B-encoding for non-ASCII header text, in words of at most 75 characters (45 UTF-8 bytes each). */
export function encodeHeaderValue(text: string): string {
  if (ASCII_PRINTABLE.test(text)) return text;
  const words: string[] = [];
  let chunk = '';
  for (const char of text) {
    if (Buffer.byteLength(chunk + char, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += char;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join(' ');
}

function formatAddress({ name, address }: Address): string {
  if (!name) return address;
  if (!ASCII_PRINTABLE.test(name)) return `${encodeHeaderValue(name)} <${address}>`;
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name)) return `${name} <${address}>`;
  return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
}

/** Fold at spaces so header lines stay near 76 characters. */
function header(name: string, value: string): string {
  const words = `${name}: ${value}`.split(' ');
  const lines: string[] = [];
  let current = words.shift()!;
  for (const word of words) {
    if (current.length + 1 + word.length > 76 && current.trim()) {
      lines.push(current);
      current = ` ${word}`;
    } else current += ` ${word}`;
  }
  lines.push(current);
  return lines.join('\r\n');
}

/** Quoted-printable (RFC 2045) for one CRLF-separated text; soft line breaks keep lines at 76 characters. */
export function encodeQuotedPrintable(text: string): string {
  return text
    .split('\r\n')
    .map((line) => {
      const bytes = Buffer.from(line, 'utf8');
      const out: string[] = [];
      let current = '';
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i];
        // Trailing spaces and tabs must be encoded, or transports may strip them.
        const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && i < bytes.length - 1);
        const token = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
        if (current.length + token.length > 75) {
          out.push(`${current}=`);
          current = '';
        }
        current += token;
      }
      out.push(current);
      return out.join('\r\n');
    })
    .join('\r\n');
}

/** One text part: 7bit when it is plain ASCII with short lines, quoted-printable otherwise. */
function textPart(content: string, subtype: 'plain' | 'html') {
  const body = content.replace(/\r\n|\r|\n/g, '\r\n');
  const sevenBit = /^[\x01-\x7f]*$/.test(body) && body.split('\r\n').every((line) => line.length <= 998);
  return {
    headers: [`Content-Type: text/${subtype}; charset=utf-8`, `Content-Transfer-Encoding: ${sevenBit ? '7bit' : 'quoted-printable'}`],
    body: sevenBit ? body : encodeQuotedPrintable(body),
  };
}

/** RFC 5322 date: "Sun, 25 Oct 2026 10:00:00 +0000". */
const formatDate = (date: Date) => date.toUTCString().replace(/GMT$/, '+0000');

/** Headers and body of the message, plus the SMTP envelope (To + CC + BCC, without duplicates). */
export function buildMessage(mail: MailOptions, clientName?: string): BuiltMessage {
  const from = parseAddressList(mail.from);
  if (from.length !== 1) throw new Error('From needs exactly one email address');
  const to = parseAddressList(mail.to);
  const cc = parseAddressList(mail.cc);
  const bcc = parseAddressList(mail.bcc);
  const replyTo = parseAddressList(mail.replyTo);
  if (!to.length && !cc.length && !bcc.length) throw new Error('Add at least one recipient (To, CC or BCC)');

  const domain = from[0].address.split('@')[1] || clientName || 'localhost';
  const messageId = mail.messageId ?? `<${randomBytes(12).toString('hex')}.${Date.now().toString(36)}@${domain}>`;
  const headers = [header('From', formatAddress(from[0]))];
  if (to.length) headers.push(header('To', to.map(formatAddress).join(', ')));
  if (cc.length) headers.push(header('Cc', cc.map(formatAddress).join(', ')));
  if (replyTo.length) headers.push(header('Reply-To', replyTo.map(formatAddress).join(', ')));
  headers.push(header('Subject', encodeHeaderValue((mail.subject ?? '').replace(/[\r\n]+/g, ' '))));
  headers.push(`Date: ${formatDate(mail.date ?? new Date())}`, `Message-ID: ${messageId}`, 'MIME-Version: 1.0');

  let body: string;
  if (mail.text !== undefined && mail.html !== undefined) {
    const boundary = `----=_landflow_${randomBytes(12).toString('hex')}`;
    const parts = [textPart(mail.text, 'plain'), textPart(mail.html, 'html')];
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    body = `${parts.map((p) => `--${boundary}\r\n${p.headers.join('\r\n')}\r\n\r\n${p.body}\r\n`).join('')}--${boundary}--\r\n`;
  } else {
    const part = mail.html !== undefined ? textPart(mail.html, 'html') : textPart(mail.text ?? '', 'plain');
    headers.push(...part.headers);
    body = part.body;
  }

  const recipients = [...new Set([...to, ...cc, ...bcc].map((a) => a.address))];
  return { raw: `${headers.join('\r\n')}\r\n\r\n${body}`, messageId, envelope: { from: from[0].address, to: recipients } };
}
