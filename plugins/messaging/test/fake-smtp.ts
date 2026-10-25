/** An in-process SMTP server for tests: EHLO/HELO, STARTTLS or implicit TLS, AUTH PLAIN/LOGIN, MAIL/RCPT/DATA. */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import tls from 'node:tls';

export interface FakeSmtpOptions {
  /** Certificate for STARTTLS (plain server) or implicit TLS (`implicitTls`). */
  tls?: { key: string; cert: string };
  implicitTls?: boolean;
  /** Require this login before MAIL FROM. */
  auth?: { user: string; password: string };
  authMethods?: string[];
  rejectRecipients?: string[];
  /** false: answer EHLO with 502, so the client falls back to HELO. */
  ehlo?: boolean;
  /** Never send the greeting (timeout tests). */
  silent?: boolean;
}

export interface ReceivedMail {
  from: string;
  to: string[];
  /** The message with dot-stuffing undone. */
  data: string;
  /** The DATA lines as they arrived on the wire. */
  wire: string[];
  secure: boolean;
  authMethod?: string;
  user?: string;
  helo: string;
}

export interface FakeSmtp {
  port: number;
  mails: ReceivedMail[];
  /** Commands as received (AUTH payloads masked). */
  commands: string[];
  close(): Promise<void>;
}

export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const mails: ReceivedMail[] = [];
  const commands: string[] = [];
  const methods = options.authMethods ?? ['PLAIN', 'LOGIN'];
  const sockets = new Set<net.Socket>();

  const session = (initial: net.Socket, initiallySecure: boolean) => {
    let socket = initial;
    let secure = initiallySecure;
    let buffer = '';
    let state: 'command' | 'data' | 'plain' | 'login-user' | 'login-pass' = 'command';
    let helo = '';
    let user: string | undefined;
    let authMethod: string | undefined;
    let pendingUser = '';
    let from = '';
    let to: string[] = [];
    let wire: string[] = [];
    sockets.add(initial);

    const reply = (...lines: string[]) =>
      socket.write(lines.map((line, i) => `${line.slice(0, 3)}${i < lines.length - 1 ? '-' : ' '}${line.slice(4)}\r\n`).join(''));
    const checkLogin = (name: string, password: string, method: string) => {
      if (options.auth && name === options.auth.user && password === options.auth.password) {
        user = name;
        authMethod = method;
        reply('235 2.7.0 Authentication successful');
      } else reply('535 5.7.8 Authentication credentials invalid');
      state = 'command';
    };
    const decode = (b64: string) => Buffer.from(b64, 'base64').toString('utf8');

    const onLine = (line: string) => {
      if (state === 'data') {
        if (line === '.') {
          mails.push({ from, to, data: `${wire.map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n')}\r\n`, wire, secure, user, authMethod, helo });
          state = 'command';
          from = '';
          to = [];
          wire = [];
          reply('250 2.0.0 Ok: queued as FAKE123');
        } else wire.push(line);
        return;
      }
      if (state === 'plain') {
        const [, name, password] = decode(line).split('\0');
        return checkLogin(name, password, 'PLAIN');
      }
      if (state === 'login-user') {
        pendingUser = decode(line);
        state = 'login-pass';
        return reply('334 UGFzc3dvcmQ6');
      }
      if (state === 'login-pass') return checkLogin(pendingUser, decode(line), 'LOGIN');

      const [verb, ...rest] = line.split(' ');
      const arg = rest.join(' ');
      commands.push(verb.toUpperCase() === 'AUTH' ? `AUTH ${rest[0]}` : line);
      switch (verb.toUpperCase()) {
        case 'EHLO':
          if (options.ehlo === false) return reply('502 5.5.2 Error: command not recognized');
          helo = arg;
          return reply(
            `250 fake.smtp greets ${arg}`,
            '250 SIZE 10485760',
            '250 8BITMIME',
            ...(options.tls && !secure ? ['250 STARTTLS'] : []),
            ...(options.auth ? [`250 AUTH ${methods.join(' ')}`] : []),
            '250 SMTPUTF8',
          );
        case 'HELO':
          helo = arg;
          return reply('250 fake.smtp');
        case 'STARTTLS': {
          if (!options.tls || secure) return reply('454 4.7.0 TLS not available');
          reply('220 2.0.0 Ready to start TLS');
          socket.off('data', onData);
          const upgraded = new tls.TLSSocket(socket, { isServer: true, secureContext: tls.createSecureContext(options.tls) });
          upgraded.on('error', () => {});
          upgraded.on('data', onData);
          socket = upgraded;
          secure = true;
          helo = '';
          return;
        }
        case 'AUTH': {
          const [method, initial] = rest;
          if (method === 'PLAIN') {
            if (initial) {
              const [, name, password] = decode(initial).split('\0');
              return checkLogin(name, password, 'PLAIN');
            }
            state = 'plain';
            return reply('334 ');
          }
          if (method === 'LOGIN') {
            state = 'login-user';
            return reply('334 VXNlcm5hbWU6');
          }
          return reply('504 5.5.4 Unrecognized authentication type');
        }
        case 'MAIL':
          if (options.auth && !user) return reply('530 5.7.0 Authentication required');
          from = /<([^>]*)>/.exec(arg)?.[1] ?? '';
          return reply('250 2.1.0 Ok');
        case 'RCPT': {
          const address = /<([^>]*)>/.exec(arg)?.[1] ?? '';
          if (options.rejectRecipients?.includes(address)) return reply(`550 5.1.1 <${address}>: Recipient address rejected: User unknown`);
          to.push(address);
          return reply('250 2.1.5 Ok');
        }
        case 'DATA':
          if (!to.length) return reply('503 5.5.1 Error: need RCPT command');
          state = 'data';
          return reply('354 End data with <CR><LF>.<CR><LF>');
        case 'RSET':
          from = '';
          to = [];
          return reply('250 2.0.0 Ok');
        case 'QUIT':
          reply('221 2.0.0 Bye');
          return socket.end();
        default:
          return reply('502 5.5.2 Error: command not recognized');
      }
    };

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        onLine(line);
      }
    };

    initial.on('data', onData);
    initial.on('error', () => {});
    initial.on('close', () => sockets.delete(initial));
    if (!options.silent) reply('220 fake.smtp ESMTP Landflow test server');
  };

  const server =
    options.implicitTls && options.tls
      ? tls.createServer({ key: options.tls.key, cert: options.tls.cert }, (socket) => session(socket, true))
      : net.createServer((socket) => session(socket, false));
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as AddressInfo).port,
    mails,
    commands,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
