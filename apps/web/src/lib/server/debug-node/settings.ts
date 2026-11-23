/**
 * The owner setting behind the one-node local override (docs/specs/19-debug-token.md): OFF by default, and when on, the
 * host may call only the hosts listed here. A `runs:debug` token cannot be minted or used while it is off.
 *
 * Allowed hosts are DNS names (a tunnel the developer opens: `abc.ngrok.app`, `dev.example.com`) or loopback addresses
 * (`localhost`, `127.0.0.1`, `::1`), with an optional port. No wildcards, and no IP literal that is not loopback, so the
 * list cannot name a private network, a link-local address or a cloud metadata endpoint.
 */
import { z } from 'zod';
import { database } from '../db';

const KEY = 'debug_node_override';

export interface DebugNodeSettings {
  enabled: boolean;
  allowedHosts: string[];
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `host` or `host:port`, lower-cased (IPv6 loopback as `[::1]`), or undefined when it is not an allowed shape. */
export function normalizeAllowedHost(entry: string): string | undefined {
  let text = entry.trim().toLowerCase();
  if (!text || /[\s*/@?#\\]/.test(text)) return undefined;
  if (text === '::1') text = '[::1]';
  let host = text;
  let port = '';
  const bracket = /^(\[[0-9a-f:]+\])(?::(\d{1,5}))?$/.exec(text);
  if (bracket) {
    host = bracket[1];
    port = bracket[2] ?? '';
  } else if (text.split(':').length === 2) {
    [host, port] = text.split(':');
  } else if (text.includes(':')) return undefined;
  if (port && (Number(port) < 1 || Number(port) > 65535)) return undefined;
  const loopback = host === 'localhost' || host === '[::1]' || (IPV4.test(host) && host.split('.')[0] === '127' && host.split('.').every((n) => Number(n) <= 255));
  if (loopback) return `${host}${port ? `:${port}` : ''}`;
  if (IPV4.test(host) || host.startsWith('[') || !HOSTNAME.test(host) || !host.includes('.')) return undefined;
  return `${host}${port ? `:${port}` : ''}`;
}

export const debugNodePatchSchema = z.strictObject({
  enabled: z.boolean().optional(),
  allowedHosts: z.array(z.string().max(260)).max(20).optional(),
});

export function getDebugNodeSettings(): DebugNodeSettings {
  try {
    const saved = JSON.parse(database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', KEY)?.value ?? '{}') as Partial<DebugNodeSettings>;
    const hosts = (Array.isArray(saved.allowedHosts) ? saved.allowedHosts : []).map((h) => normalizeAllowedHost(String(h))).filter((h): h is string => Boolean(h));
    return { enabled: saved.enabled === true, allowedHosts: [...new Set(hosts)] };
  } catch {
    return { enabled: false, allowedHosts: [] };
  }
}

/** Apply a patch; throws a message for an entry that is not an allowed host shape. */
export function updateDebugNodeSettings(patch: z.infer<typeof debugNodePatchSchema>): DebugNodeSettings {
  const current = getDebugNodeSettings();
  let allowedHosts = current.allowedHosts;
  if (patch.allowedHosts) {
    allowedHosts = [];
    for (const entry of patch.allowedHosts) {
      if (!entry.trim()) continue;
      const host = normalizeAllowedHost(entry);
      if (!host) throw new Error(`“${entry}” is not an allowed host: use a DNS name (a tunnel) or localhost / 127.0.0.1 / ::1, with an optional port, and no wildcards`);
      if (!allowedHosts.includes(host)) allowedHosts.push(host);
    }
  }
  const next: DebugNodeSettings = { enabled: patch.enabled ?? current.enabled, allowedHosts };
  database().upsert('settings', { key: KEY, value: JSON.stringify(next) });
  return next;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Loopback names are one host: `localhost`, `127.0.0.1` and `[::1]` all become `localhost` (the port suffix is kept). */
function canonicalHost(entry: string): string {
  const m = /^(\[::1\]|[^:]+)(:\d+)?$/.exec(entry);
  return m && LOOPBACK_NAMES.has(m[1]) ? `localhost${m[2] ?? ''}` : entry;
}

/** The plugin URL if the host may call it: http(s), no credentials, a host on the list (with the port, when the entry names one). */
export function checkPluginUrl(raw: string, settings = getDebugNodeSettings()): { ok: true; url: URL } | { ok: false; reason: string } {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'The plugin URL is not a URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, reason: 'The plugin URL must be http or https' };
  if (url.username || url.password) return { ok: false, reason: 'The plugin URL must not carry credentials' };
  const host = canonicalHost(url.hostname.toLowerCase());
  const listed = settings.allowedHosts.some((raw) => {
    const entry = canonicalHost(raw);
    return entry === host || (url.port !== '' && entry === `${host}:${url.port}`);
  });
  if (!listed) return { ok: false, reason: `The host “${url.host}” is not on the owner’s allowed list for local node overrides` };
  return { ok: true, url };
}
