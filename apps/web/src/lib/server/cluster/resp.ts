/**
 * A small Valkey (Redis protocol, RESP2) client: pipelined commands over one socket, reconnects with backoff, AUTH and
 * SELECT from the URL, and a subscriber mode for pub/sub. Queue mode needs a few dozen commands and pub/sub, so this
 * keeps a client library (and its native or Lua-heavy extras) out of the host and the worker bundle.
 *
 * Replies: simple strings and bulk strings as strings (UTF-8), integers as numbers, nil as null, arrays as arrays; an
 * error reply rejects the call with a RespError. A command sent while the connection is down waits for the reconnect
 * (bounded queue); `timeoutMs` rejects a call that got no reply in time (blocking reads pass 0).
 */
import { EventEmitter } from 'node:events';
import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export type RespValue = string | number | null | RespValue[];
export type RespArg = string | number | Buffer;

export class RespError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RespError';
  }
}

const CRLF = Buffer.from('\r\n');

/** One command in RESP: an array of bulk strings. */
export function encodeCommand(args: readonly RespArg[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`)];
  for (const arg of args) {
    const value = Buffer.isBuffer(arg) ? arg : Buffer.from(String(arg));
    parts.push(Buffer.from(`$${value.length}\r\n`), value, CRLF);
  }
  return Buffer.concat(parts);
}

/** Incremental RESP2 reply parser: push bytes, take complete replies. Error replies come out as RespError values. */
export class RespParser {
  private buffer: Buffer = Buffer.alloc(0);

  push(chunk: Buffer) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
  }

  /** The next complete reply, or undefined until more bytes arrive. */
  next(): { value: RespValue | RespError } | undefined {
    const parsed = this.read(0);
    if (!parsed) return undefined;
    this.buffer = this.buffer.subarray(parsed.end);
    return { value: parsed.value };
  }

  private read(start: number): { value: RespValue | RespError; end: number } | undefined {
    if (start >= this.buffer.length) return undefined;
    const lineEnd = this.buffer.indexOf(CRLF, start);
    if (lineEnd < 0) return undefined;
    const type = this.buffer[start];
    const text = this.buffer.toString('utf8', start + 1, lineEnd);
    const end = lineEnd + 2;
    switch (type) {
      case 0x2b: // +
        return { value: text, end };
      case 0x2d: // -
        return { value: new RespError(text), end };
      case 0x3a: // :
        return { value: Number(text), end };
      case 0x24: {
        // $
        const length = Number(text);
        if (length < 0) return { value: null, end };
        if (this.buffer.length < end + length + 2) return undefined;
        return { value: this.buffer.toString('utf8', end, end + length), end: end + length + 2 };
      }
      case 0x2a: {
        // *
        const count = Number(text);
        if (count < 0) return { value: null, end };
        const items: RespValue[] = [];
        let at = end;
        for (let i = 0; i < count; i++) {
          const item = this.read(at);
          if (!item) return undefined;
          // An error inside an array (EXEC, scripts) stays a value: callers that care check for it.
          items.push(item.value as RespValue);
          at = item.end;
        }
        return { value: items, end: at };
      }
      default:
        throw new RespError(`Unexpected reply type "${String.fromCharCode(type)}"`);
    }
  }
}

export interface RespOptions {
  url: string;
  /** CLIENT SETNAME, shown by CLIENT LIST. */
  name?: string;
  /** Reject a call without a reply after this long (0 = never). Default 10 s. */
  timeoutMs?: number;
  /** A subscriber connection: only (P)SUBSCRIBE, (P)UNSUBSCRIBE and PING. */
  subscriber?: boolean;
  /** Calls kept while disconnected (default 10 000); more are rejected at once. */
  maxQueued?: number;
}

interface Pending {
  resolve: (value: RespValue) => void;
  reject: (error: Error) => void;
  settled: boolean;
  timer?: NodeJS.Timeout;
}

/** The parts of a `redis://` / `rediss://` / `valkey://` URL. */
export function parseValkeyUrl(url: string): { host: string; port: number; tls: boolean; username?: string; password?: string; db?: number } {
  const parsed = new URL(url);
  if (!/^(redis|rediss|valkey|valkeys):$/.test(parsed.protocol)) throw new Error(`Not a Valkey URL: ${parsed.protocol}// (use redis:// or rediss://)`);
  const db = parsed.pathname.replace(/^\//, '');
  return {
    host: parsed.hostname || '127.0.0.1',
    port: Number(parsed.port) || 6379,
    tls: parsed.protocol === 'rediss:' || parsed.protocol === 'valkeys:',
    ...(parsed.username && { username: decodeURIComponent(parsed.username) }),
    ...(parsed.password && { password: decodeURIComponent(parsed.password) }),
    ...(db && Number.isInteger(Number(db)) && { db: Number(db) }),
  };
}

type MessageHandler = (message: string, channel: string) => void;

export class RespClient extends EventEmitter {
  private socket?: Socket;
  private parser = new RespParser();
  private readonly inflight: Pending[] = [];
  private queued: Array<{ payload: Buffer; pending: Pending }> = [];
  private state: 'idle' | 'connecting' | 'ready' | 'closed' = 'idle';
  private failures = 0;
  private reconnectTimer?: NodeJS.Timeout;
  private readonly channels = new Map<string, Set<MessageHandler>>();
  private readonly patterns = new Map<string, Set<MessageHandler>>();
  private readonly target: ReturnType<typeof parseValkeyUrl>;

  constructor(private readonly options: RespOptions) {
    super();
    this.target = parseValkeyUrl(options.url);
    // Errors are reported through rejected calls and 'error' events nobody has to listen to.
    this.on('error', () => {});
  }

  get ready(): boolean {
    return this.state === 'ready';
  }

  /** Send a command; resolves with its reply. */
  call(...args: RespArg[]): Promise<RespValue> {
    return this.send(args, this.options.timeoutMs ?? 10_000);
  }

  /** A command with its own timeout (0 = none, for blocking reads). */
  callWithTimeout(timeoutMs: number, ...args: RespArg[]): Promise<RespValue> {
    return this.send(args, timeoutMs);
  }

  private send(args: RespArg[], timeoutMs: number): Promise<RespValue> {
    if (this.state === 'closed') return Promise.reject(new Error('Valkey connection closed'));
    return new Promise<RespValue>((resolve, reject) => {
      const pending: Pending = { resolve, reject, settled: false };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => this.settle(pending, new Error(`Valkey: no reply to ${String(args[0])} within ${timeoutMs} ms`)), timeoutMs);
        pending.timer.unref?.();
      }
      const payload = encodeCommand(args);
      if (this.state === 'ready' && this.socket) {
        this.inflight.push(pending);
        this.socket.write(payload);
        return;
      }
      if (this.queued.length >= (this.options.maxQueued ?? 10_000)) return this.settle(pending, new Error('Valkey is unreachable and too many commands are waiting'));
      this.queued.push({ payload, pending });
      this.connect();
    });
  }

  private settle(pending: Pending, outcome: Error | { value: RespValue }) {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.timer) clearTimeout(pending.timer);
    if (outcome instanceof Error) pending.reject(outcome);
    else pending.resolve(outcome.value);
  }

  /** Open the connection (also done by the first call). */
  connect() {
    if (this.state !== 'idle') return;
    this.state = 'connecting';
    const { host, port, tls } = this.target;
    const socket = tls ? tlsConnect({ host, port, servername: host }) : netConnect({ host, port });
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30_000);
    socket.once(tls ? 'secureConnect' : 'connect', () => this.onConnect(socket));
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => this.onClose(socket));
  }

  private onConnect(socket: Socket) {
    if (this.socket !== socket) return;
    this.parser = new RespParser();
    const handshake: RespArg[][] = [];
    const { username, password, db } = this.target;
    if (password) handshake.push(username ? ['AUTH', username, password] : ['AUTH', password]);
    if (db) handshake.push(['SELECT', db]);
    if (this.options.name) handshake.push(['CLIENT', 'SETNAME', this.options.name.replace(/\s/g, '_')]);
    for (const args of handshake) {
      const pending: Pending = {
        resolve: () => {},
        reject: (error) => this.emit('error', new Error(`Valkey handshake (${String(args[0])}) failed: ${error.message}`)),
        settled: false,
      };
      this.inflight.push(pending);
      socket.write(encodeCommand(args));
    }
    // Subscriptions come back after a reconnect.
    for (const channel of this.channels.keys()) this.writeInternal(socket, ['SUBSCRIBE', channel]);
    for (const pattern of this.patterns.keys()) this.writeInternal(socket, ['PSUBSCRIBE', pattern]);
    this.state = 'ready';
    this.failures = 0;
    const queued = this.queued;
    this.queued = [];
    for (const { payload, pending } of queued) {
      if (pending.settled) continue;
      this.inflight.push(pending);
      socket.write(payload);
    }
    this.emit('ready');
  }

  /** A command whose reply nobody waits for (re-subscribing). */
  private writeInternal(socket: Socket, args: RespArg[]) {
    this.inflight.push({ resolve: () => {}, reject: () => {}, settled: false });
    socket.write(encodeCommand(args));
  }

  private onData(chunk: Buffer) {
    this.parser.push(chunk);
    for (;;) {
      let parsed: { value: RespValue | RespError } | undefined;
      try {
        parsed = this.parser.next();
      } catch (error) {
        this.emit('error', error);
        this.socket?.destroy();
        return;
      }
      if (!parsed) return;
      const { value } = parsed;
      if (this.options.subscriber && Array.isArray(value) && this.isPush(value)) continue;
      const pending = this.inflight.shift();
      if (!pending) continue;
      this.settle(pending, value instanceof RespError ? value : { value });
    }
  }

  /** Subscriber mode: deliver messages; true when the reply was a message (not the answer to a command). */
  private isPush(value: RespValue[]): boolean {
    const kind = String(value[0]).toLowerCase();
    if (kind === 'message') {
      const channel = String(value[1]);
      for (const handler of this.channels.get(channel) ?? []) this.deliver(handler, String(value[2] ?? ''), channel);
      return true;
    }
    if (kind === 'pmessage') {
      const channel = String(value[2]);
      for (const handler of this.patterns.get(String(value[1])) ?? []) this.deliver(handler, String(value[3] ?? ''), channel);
      return true;
    }
    return false;
  }

  private deliver(handler: MessageHandler, message: string, channel: string) {
    try {
      handler(message, channel);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private onClose(socket: Socket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    const error = new Error('Valkey connection lost');
    for (const pending of this.inflight.splice(0)) this.settle(pending, error);
    if (this.state === 'closed') return;
    const wasReady = this.state === 'ready';
    this.state = 'idle';
    if (wasReady) this.emit('disconnected');
    this.failures++;
    const delay = Math.min(5_000, 100 * 2 ** Math.min(this.failures, 6));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
    this.reconnectTimer.unref?.();
  }

  /** Subscriber connections: receive messages published on `channel`. Resolves once subscribed. */
  async subscribe(channel: string, handler: MessageHandler): Promise<() => Promise<void>> {
    return this.listen(this.channels, 'SUBSCRIBE', 'UNSUBSCRIBE', channel, handler);
  }

  /** Subscriber connections: receive messages on every channel matching `pattern`. */
  async psubscribe(pattern: string, handler: MessageHandler): Promise<() => Promise<void>> {
    return this.listen(this.patterns, 'PSUBSCRIBE', 'PUNSUBSCRIBE', pattern, handler);
  }

  private async listen(map: Map<string, Set<MessageHandler>>, on: string, off: string, name: string, handler: MessageHandler) {
    if (!this.options.subscriber) throw new Error('subscribe() needs a subscriber connection');
    let handlers = map.get(name);
    if (!handlers) {
      handlers = new Set();
      map.set(name, handlers);
      // Waits for the server's confirmation (a call made while disconnected goes out once connected; onConnect also
      // subscribes everything in the map, which a reconnect needs).
      await this.call(on, name);
    }
    handlers.add(handler);
    return async () => {
      const set = map.get(name);
      if (!set?.delete(handler) || set.size) return;
      map.delete(name);
      if (this.state === 'ready') await this.call(off, name).catch(() => {});
    };
  }

  /** Close for good: queued and in-flight calls are rejected. */
  async close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    clearTimeout(this.reconnectTimer);
    const error = new Error('Valkey connection closed');
    for (const { pending } of this.queued.splice(0)) this.settle(pending, error);
    for (const pending of this.inflight.splice(0)) this.settle(pending, error);
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    await new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
      socket.end();
      setTimeout(() => {
        socket.destroy();
        resolve();
      }, 1_000).unref?.();
    });
  }
}

/** A flat [field, value, field, value…] reply as an object. */
export function pairs(reply: RespValue): Record<string, string> {
  const out: Record<string, string> = {};
  if (!Array.isArray(reply)) return out;
  for (let i = 0; i + 1 < reply.length; i += 2) out[String(reply[i])] = String(reply[i + 1]);
  return out;
}
