/** Indicator extraction: refang, find, classify, dedupe. Pure functions. */
import { isIPv6 } from 'node:net';
import { isObj } from './util';

export const IOC_TYPES = ['ipv4', 'ipv6', 'domain', 'url', 'email', 'md5', 'sha1', 'sha256', 'cve'] as const;
export type IocType = (typeof IOC_TYPES)[number];

export interface Ioc {
  type: IocType;
  value: string;
  defanged: string;
  private?: boolean;
}

export interface ExtractOptions {
  types?: readonly IocType[];
  dropPrivate?: boolean;
}

/** Turn "hxxps://evil[.]com", "1.2.3[.]4", "a[at]b.com" and friends back into live indicators. */
export function refang(text: string): string {
  return text
    .replace(/\bh(?:xx|\*\*|tt)p(s?)(?=:|\[:|\(:)/gi, 'http$1')
    .replace(/\bfxp\b/gi, 'ftp')
    .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|\[dot\]|\(dot\)|\{dot\}/gi, '.')
    .replace(/\[:\]|\(:\)|\{:\}/g, ':')
    .replace(/\[\/\]/g, '/')
    .replace(/\[:\/\/\]/g, '://')
    .replace(/\s?\[at\]\s?|\s?\(at\)\s?|\[@\]|\(@\)/gi, '@');
}

// Common TLDs. Ambiguous ones (also file extensions: .sh, .py, .md, .zip, ...) are listed separately and only count
// inside a URL or an e-mail address.
const TLDS = new Set(
  (
    'com net org edu gov mil int io co ai app dev xyz info biz online site tech store cloud top club shop live me tv us uk de fr nl ru cn jp kr in br au ca es it se no fi dk ch at be cz ro hu gr pt ie il tr ua za mx ar cl nz sg hk tw id my th vn ph ir sa ae eu asia name pro mobi tk ga gq work link click page world today email support network systems solutions services digital global group agency news blog media space website fun icu vip bid win loan men party review trade stream download xin pw su by kz lt lv ee sk si hr bg is lu li mt cy ke ng gh eg ma tn pk bd lk np ve pe uy ec bo py cr pa do gt hn ni sv cu jm tt example aero coop museum travel jobs tel cat'
  ).split(' '),
);
const AMBIGUOUS_TLDS = new Set(['sh', 'py', 'pl', 'rs', 'md', 'zip', 'mov', 'so', 'pm', 'cc', 'ps', 'cs', 'ml', 'sc', 'ws', 'to', 'am', 'fm']);
for (const t of AMBIGUOUS_TLDS) TLDS.delete(t);

function tldOf(domain: string): string {
  return domain.slice(domain.lastIndexOf('.') + 1).toLowerCase();
}

function validDomain(domain: string, trusted: boolean): boolean {
  if (domain.length > 253 || !domain.includes('.')) return false;
  const labels = domain.split('.');
  if (labels.some((l) => !l || l.length > 63 || l.startsWith('-') || l.endsWith('-'))) return false;
  const tld = tldOf(domain);
  if (TLDS.has(tld)) return true;
  return trusted && AMBIGUOUS_TLDS.has(tld);
}

// --- IP classification ------------------------------------------------------------------------------------------

export function isPrivateIpv4(ip: string): boolean {
  const [a, b, c] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

export function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  const head = lower.startsWith('::') ? 0 : parseInt(lower.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((head & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (lower.startsWith('2001:db8:') || lower === '2001:db8::') return true; // documentation
  return false;
}

// --- defanging --------------------------------------------------------------------------------------------------

export function defang(type: IocType, value: string): string {
  switch (type) {
    case 'ipv4':
    case 'domain':
      return value.replace(/\./g, '[.]');
    case 'ipv6':
      return value.replace(/:/g, '[:]');
    case 'url':
      return value.replace(/^http/i, 'hxxp').replace(/^ftp/i, 'fxp').replace(/^(\w+:\/\/)([^/?#]*)/, (_m, scheme: string, host: string) => scheme + host.replace(/\./g, '[.]'));
    case 'email':
      return value.replace('@', '[@]').replace(/\./g, '[.]');
    default:
      return value;
  }
}

// --- extraction -------------------------------------------------------------------------------------------------

const URL_RE = /\b(?:https?|ftp):\/\/[^\s<>"'`\\^{}|]+/gi;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;
const IPV4_RE = /(?<![\d.])(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d|\.\d)/g;
const IPV6_RE = /(?<![\w:.])(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?![\w:]|\.\d)/g;
const DOMAIN_RE = /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}(?![\w-]|\()/gi;
const HASH_RES: Array<[IocType, RegExp]> = [
  ['sha256', /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/gi],
  ['sha1', /(?<![0-9a-f])[0-9a-f]{40}(?![0-9a-f])/gi],
  ['md5', /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi],
];
const CVE_RE = /\bCVE-\d{4}-\d{4,7}\b/gi;

function trimUrl(raw: string): string {
  let u = raw.replace(/[.,;:!?'"\]]+$/, '');
  while (u.endsWith(')') && (u.match(/\(/g) ?? []).length < (u.match(/\)/g) ?? []).length) u = u.slice(0, -1).replace(/[.,;:!?]+$/, '');
  return u;
}

function hostOf(url: string): string {
  const m = /^\w+:\/\/(?:[^@/?#]*@)?(\[[^\]]+\]|[^:/?#]+)/.exec(url);
  return (m?.[1] ?? '').toLowerCase();
}

/** Every string inside a value, joined with newlines. */
export function collectText(value: unknown, limit = 2_000_000): string {
  const parts: string[] = [];
  let size = 0;
  const visit = (v: unknown, depth: number) => {
    if (size > limit || depth > 12) return;
    if (typeof v === 'string') {
      parts.push(v);
      size += v.length;
    } else if (Array.isArray(v)) v.forEach((x) => visit(x, depth + 1));
    else if (isObj(v)) Object.values(v).forEach((x) => visit(x, depth + 1));
  };
  visit(value, 0);
  return parts.join('\n');
}

export function extractIocs(input: string, options: ExtractOptions = {}): Ioc[] {
  const want = new Set<IocType>(options.types?.length ? options.types : IOC_TYPES);
  const text = refang(input);
  const out = new Map<string, Ioc>();
  const add = (type: IocType, value: string, extra: Partial<Ioc> = {}) => {
    if (!want.has(type)) return;
    const key = `${type}:${value}`;
    if (!out.has(key)) out.set(key, { type, value, defanged: defang(type, value), ...extra });
  };

  const urlHosts = new Set<string>();
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (url.length > 8) {
      add('url', url);
      const host = hostOf(url);
      if (host && !/^[\d.]+$/.test(host) && !host.startsWith('[')) urlHosts.add(host);
    }
  }

  const emailDomains = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    const email = m[0].replace(/[._%+-]+$/, '').toLowerCase();
    const domain = email.slice(email.indexOf('@') + 1);
    if (validDomain(domain, true)) {
      add('email', email);
      emailDomains.add(domain);
    }
  }

  const ipv4 = new Set<string>();
  for (const m of text.matchAll(IPV4_RE)) ipv4.add(m[0]);
  for (const ip of ipv4) {
    const priv = isPrivateIpv4(ip);
    if (!(options.dropPrivate && priv)) add('ipv4', ip, { private: priv });
  }

  for (const m of text.matchAll(IPV6_RE)) {
    const ip = m[0];
    if (ip.length < 3 || !isIPv6(ip)) continue;
    if (ip === '::') continue;
    const normalized = ip.toLowerCase();
    const priv = isPrivateIpv6(normalized);
    if (!(options.dropPrivate && priv)) add('ipv6', normalized, { private: priv });
  }

  // Domains: URL hosts and e-mail domains count with any TLD we know; bare names need an unambiguous TLD.
  for (const host of [...urlHosts, ...emailDomains]) if (validDomain(host, true)) add('domain', host);
  for (const m of text.matchAll(DOMAIN_RE)) {
    const d = m[0].toLowerCase();
    if (validDomain(d, false) && !/^\d+(\.\d+)+$/.test(d)) add('domain', d);
  }

  for (const [type, re] of HASH_RES) {
    for (const m of text.matchAll(re)) {
      if (/\d/.test(m[0]) && /[a-f]/i.test(m[0])) add(type, m[0].toLowerCase());
    }
  }
  for (const m of text.matchAll(CVE_RE)) add('cve', m[0].toUpperCase());

  return [...out.values()];
}

export function countIocs(iocs: Ioc[]): Record<IocType, number> {
  const counts = Object.fromEntries(IOC_TYPES.map((t) => [t, 0])) as Record<IocType, number>;
  for (const i of iocs) counts[i.type]++;
  return counts;
}
