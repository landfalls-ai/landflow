/** A small, forgiving RFC 822 / MIME parser for phishing reports. No dependencies; never throws on malformed input. */
import { sha256Hex } from './util';

export interface Address {
  name: string;
  address: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  disposition: string;
  contentId?: string;
  /** Kept for the node to emit as binary; stripped from the JSON output. */
  content?: Buffer;
}

export interface ParsedEmail {
  headers: {
    from: Address | null;
    to: Address[];
    cc: Address[];
    replyTo: Address[];
    returnPath: string | null;
    subject: string;
    date: string | null;
    dateRaw: string | null;
    messageId: string | null;
    received: string[];
  };
  allHeaders: Record<string, string | string[]>;
  authentication: {
    spf: string | null;
    dkim: string | null;
    dmarc: string | null;
    dkimAll: string[];
    raw: string[];
  };
  fromDomain: string | null;
  replyToMismatch: boolean;
  returnPathMismatch: boolean;
  text: string;
  html: string;
  urls: string[];
  attachments: EmailAttachment[];
  warnings: string[];
}

type HeaderList = Array<[string, string]>;

interface Part {
  headers: HeaderList;
  body: string;
}

const MAX_DEPTH = 8;
const MAX_PARTS = 200;

/** Bytes as a "binary string" (one char per byte), so every later step works on bytes whatever the input was. */
export function toBinaryString(input: string | Buffer): string {
  return (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('latin1');
}

function bytes(s: string): Buffer {
  return Buffer.from(s, 'latin1');
}

export function decodeCharset(buf: Buffer, charset?: string): string {
  const label = (charset ?? 'utf-8').trim().toLowerCase().replace(/^"|"$/g, '') || 'utf-8';
  try {
    return new TextDecoder(label === 'utf8' ? 'utf-8' : label).decode(buf);
  } catch {
    try {
      return new TextDecoder('utf-8').decode(buf);
    } catch {
      return buf.toString('latin1');
    }
  }
}

function splitHeadBody(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw);
  if (!m) return [raw, ''];
  return [raw.slice(0, m.index), raw.slice(m.index + m[0].length)];
}

function parseHeaders(block: string): HeaderList {
  const lines = block.split(/\r?\n/);
  const out: HeaderList = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && out.length > 0) {
      out[out.length - 1][1] += ' ' + line.trim();
      continue;
    }
    const i = line.indexOf(':');
    if (i <= 0 || /\s/.test(line.slice(0, i))) continue; // mbox "From " line, junk
    out.push([line.slice(0, i).toLowerCase(), line.slice(i + 1).trim()]);
  }
  return out;
}

const header = (h: HeaderList, name: string): string | undefined => h.find(([k]) => k === name)?.[1];
const headerAll = (h: HeaderList, name: string): string[] => h.filter(([k]) => k === name).map(([, v]) => v);

/** RFC 2047 encoded words: =?utf-8?B?...?= and =?iso-8859-1?Q?...?= */
export function decodeWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(=\?)/g, '$1$2');
  return joined.replace(/=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, charset: string, enc: string, text: string) => {
    try {
      const data = enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : qpBytes(text.replace(/_/g, ' '));
      return decodeCharset(data, charset.split('*')[0]);
    } catch {
      return text;
    }
  });
}

function qpBytes(text: string): Buffer {
  const cleaned = text.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (c === '=' && /^[0-9a-fA-F]{2}$/.test(cleaned.slice(i + 1, i + 3))) {
      out.push(parseInt(cleaned.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(cleaned.charCodeAt(i) & 0xff);
  }
  return Buffer.from(out);
}

interface ContentType {
  type: string;
  params: Record<string, string>;
}

function parseParams(rest: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /;\s*([^=;\s]+)\s*=\s*("((?:[^"\\]|\\.)*)"|[^;]*)/g;
  for (const m of rest.matchAll(re)) {
    const key = m[1].toLowerCase();
    let val = m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[2].trim();
    const star = /^([^*]+)\*(\d+)?\*?$/.exec(key);
    if (star) {
      // RFC 2231: filename*=utf-8''%E2%82%AC.txt and filename*0=...; filename*1=...
      const enc = /^([\w-]*)'[^']*'(.*)$/.exec(val);
      const raw = enc ? enc[2] : val;
      const decoded = decodeCharset(Buffer.from(raw.replace(/%([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1'), enc?.[1] || 'utf-8');
      params[star[1]] = (star[2] !== undefined ? (params[star[1]] ?? '') : '') + decoded;
      continue;
    }
    if (!(key in params)) params[key] = val;
  }
  return params;
}

function parseContentType(v: string | undefined): ContentType {
  if (!v) return { type: 'text/plain', params: {} };
  const semi = v.indexOf(';');
  const type = (semi < 0 ? v : v.slice(0, semi)).trim().toLowerCase() || 'text/plain';
  return { type, params: semi < 0 ? {} : parseParams(v.slice(semi)) };
}

function decodeTransfer(body: string, encoding: string): Buffer {
  switch (encoding.trim().toLowerCase()) {
    case 'base64':
      return Buffer.from(body.replace(/[^A-Za-z0-9+/_-]/g, ''), 'base64');
    case 'quoted-printable':
      return qpBytes(body);
    default:
      return bytes(body);
  }
}

function parsePart(raw: string): Part {
  const [head, body] = splitHeadBody(raw);
  return { headers: parseHeaders(head), body };
}

function splitMultipart(body: string, boundary: string): string[] {
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?:^|\\r?\\n)--${escaped}(--)?[ \\t]*(?=\\r?\\n|$)`, 'g');
  const parts: string[] = [];
  let last = -1;
  for (const m of body.matchAll(re)) {
    if (last >= 0) parts.push(body.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) break;
    if (body[last] === '\r') last++;
    if (body[last] === '\n') last++;
  }
  // Truncated message: no closing boundary.
  if (last >= 0 && parts.length === 0 && last < body.length) parts.push(body.slice(last));
  else if (last >= 0 && !new RegExp(`--${escaped}--`).test(body) && last < body.length) parts.push(body.slice(last));
  return parts;
}

// --- addresses --------------------------------------------------------------------------------------------------

export function parseAddresses(value: string | undefined): Address[] {
  if (!value) return [];
  const decoded = decodeWords(value);
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let cur = '';
  for (const ch of decoded) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') depth++;
    if (!quoted && ch === '>') depth = Math.max(0, depth - 1);
    if (!quoted && depth === 0 && (ch === ',' || ch === ';')) {
      items.push(cur);
      cur = '';
    } else cur += ch;
  }
  items.push(cur);
  const out: Address[] = [];
  for (const item of items) {
    const t = item.trim();
    if (!t) continue;
    const angle = /<([^<>]*)>/.exec(t);
    const address = (angle ? angle[1] : /[^\s<>"()]+@[^\s<>"()]+/.exec(t)?.[0] ?? '').trim().toLowerCase();
    let name = (angle ? t.slice(0, angle.index) : t.replace(address, '')).trim().replace(/^"|"$/g, '').replace(/\\(.)/g, '$1').trim();
    if (name === address) name = '';
    if (address || name) out.push({ name, address });
  }
  return out;
}

const domainOf = (address: string | undefined | null): string | null => {
  const i = (address ?? '').lastIndexOf('@');
  return i >= 0 ? address!.slice(i + 1).toLowerCase() : null;
};

// --- authentication ---------------------------------------------------------------------------------------------

function parseAuth(h: HeaderList): ParsedEmail['authentication'] {
  const raw = headerAll(h, 'authentication-results');
  const results: Record<string, string[]> = { spf: [], dkim: [], dmarc: [] };
  for (const line of raw) {
    for (const m of line.matchAll(/(?:^|[\s;])(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi)) results[m[1].toLowerCase()].push(m[2].toLowerCase());
  }
  if (results.spf.length === 0) {
    const received = header(h, 'received-spf')?.match(/^\s*([a-z]+)/i)?.[1];
    if (received) results.spf.push(received.toLowerCase());
  }
  return {
    spf: results.spf[0] ?? null,
    dkim: results.dkim.find((v) => v === 'pass') ?? results.dkim[0] ?? null,
    dmarc: results.dmarc[0] ?? null,
    dkimAll: results.dkim,
    raw,
  };
}

// --- bodies and URLs --------------------------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .trim();
}

function findUrls(text: string, html: string): string[] {
  const urls: string[] = [];
  for (const m of html.matchAll(/\b(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const u = decodeEntities((m[1] ?? m[2] ?? m[3] ?? '').trim());
    if (/^https?:\/\//i.test(u)) urls.push(u);
  }
  for (const source of [text, decodeEntities(html.replace(/<[^>]*>/g, ' '))]) {
    for (const m of source.matchAll(/\bhttps?:\/\/[^\s<>"'`)\]]+/gi)) urls.push(m[0].replace(/[.,;:!?]+$/, ''));
  }
  return [...new Set(urls)].slice(0, 200);
}

// --- main -------------------------------------------------------------------------------------------------------

export function parseEmail(input: string | Buffer): ParsedEmail {
  const warnings: string[] = [];
  const root = parsePart(toBinaryString(input).replace(/^From [^\r\n]*\r?\n/, ''));
  if (root.headers.length === 0) warnings.push('No headers found: the input may not be an RFC 822 message');

  const texts: string[] = [];
  const htmls: string[] = [];
  const attachments: EmailAttachment[] = [];
  let count = 0;

  const walkPart = (part: Part, depth: number) => {
    if (++count > MAX_PARTS) {
      if (count === MAX_PARTS + 1) warnings.push(`More than ${MAX_PARTS} MIME parts: the rest were skipped`);
      return;
    }
    const ct = parseContentType(header(part.headers, 'content-type'));
    const disposition = (header(part.headers, 'content-disposition') ?? '').trim();
    const dispType = disposition.split(';')[0].trim().toLowerCase();
    const dispParams = parseParams(disposition.includes(';') ? disposition.slice(disposition.indexOf(';')) : '');
    if (ct.type.startsWith('multipart/') && depth < MAX_DEPTH) {
      const boundary = ct.params.boundary;
      if (!boundary) {
        warnings.push('Multipart message without a boundary');
        return;
      }
      for (const raw of splitMultipart(part.body, boundary)) walkPart(parsePart(raw), depth + 1);
      return;
    }
    const filenameRaw = dispParams.filename ?? ct.params.name ?? '';
    const filename = decodeWords(filenameRaw);
    const encoding = header(part.headers, 'content-transfer-encoding') ?? '7bit';
    const isText = ct.type === 'text/plain' || ct.type === 'text/html';
    if (isText && dispType !== 'attachment' && !filename) {
      const text = decodeCharset(decodeTransfer(part.body, encoding), ct.params.charset);
      (ct.type === 'text/html' ? htmls : texts).push(text);
      return;
    }
    const content = decodeTransfer(part.body, encoding);
    const contentId = header(part.headers, 'content-id')?.replace(/^<|>$/g, '');
    attachments.push({
      filename: filename || (ct.type === 'message/rfc822' ? 'message.eml' : `part-${attachments.length + 1}`),
      contentType: ct.type,
      size: content.length,
      sha256: sha256Hex(content),
      disposition: dispType || 'attachment',
      ...(contentId && { contentId }),
      content,
    });
  };
  walkPart(root, 0);

  const text = texts.join('\n').trim();
  const html = htmls.join('\n').trim();
  const h = root.headers;
  const from = parseAddresses(header(h, 'from'))[0] ?? null;
  const replyTo = parseAddresses(header(h, 'reply-to'));
  const returnPath = parseAddresses(header(h, 'return-path'))[0]?.address || null;
  const dateRaw = header(h, 'date') ?? null;
  const parsedDate = dateRaw ? Date.parse(dateRaw) : NaN;
  const fromDomain = domainOf(from?.address);
  const grouped: Record<string, string | string[]> = {};
  for (const [k, v] of h) {
    const decoded = decodeWords(v);
    const prev = grouped[k];
    grouped[k] = prev === undefined ? decoded : Array.isArray(prev) ? [...prev, decoded] : [prev, decoded];
  }

  return {
    headers: {
      from,
      to: parseAddresses(header(h, 'to')),
      cc: parseAddresses(header(h, 'cc')),
      replyTo,
      returnPath,
      subject: decodeWords(header(h, 'subject') ?? ''),
      date: Number.isNaN(parsedDate) ? null : new Date(parsedDate).toISOString(),
      dateRaw,
      messageId: header(h, 'message-id')?.replace(/^<|>$/g, '') ?? null,
      received: headerAll(h, 'received'),
    },
    allHeaders: grouped,
    authentication: parseAuth(h),
    fromDomain,
    replyToMismatch: !!fromDomain && replyTo.some((a) => !!domainOf(a.address) && domainOf(a.address) !== fromDomain),
    returnPathMismatch: !!fromDomain && !!returnPath && domainOf(returnPath) !== fromDomain,
    text: text || (html ? htmlToText(html) : ''),
    html,
    urls: findUrls(text, html),
    attachments,
    warnings,
  };
}
