/**
 * Checking an allow-list a person typed (an API key's addresses and ranges), in a module with no Node imports so the
 * settings form checks a line as it is typed with the very rule the server applies (server/net/ip-allow.ts re-exports
 * it): an IPv4 or IPv6 address, a CIDR range with a valid prefix, or `localhost`; at most 50 entries; the problem names
 * the entry.
 */

/** The most entries a list may hold (an API key's). */
export const MAX_ALLOW_ENTRIES = 50;
const MAX_ENTRY_LENGTH = 100;

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HEX_GROUP = /^[0-9a-f]{1,4}$/i;

function isIpv6(text: string): boolean {
  if (!text.includes(':') || /[^0-9a-f:.]/i.test(text)) return false;
  let groups = text;
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    if (!V4.test(v4[1])) return false;
    groups = `${text.slice(0, -v4[1].length)}0:0`;
  }
  const halves = groups.split('::');
  if (halves.length > 2) return false;
  const parts = halves.flatMap((half) => (half ? half.split(':') : []));
  if (!parts.every((part) => HEX_GROUP.test(part))) return false;
  return halves.length === 2 ? parts.length <= 7 : parts.length === 8;
}

/** 4 for an IPv4 address, 6 for an IPv6 one, 0 for neither. */
export function ipFamily(text: string): 0 | 4 | 6 {
  return V4.test(text) ? 4 : isIpv6(text) ? 6 : 0;
}

/** Why `entry` is not a valid address, range or `localhost` (naming it), or undefined when it is. */
export function ipEntryProblem(entry: string): string | undefined {
  const text = entry.trim();
  if (!text) return 'An address or range is empty';
  const shown = text.length > 40 ? `${text.slice(0, 40)}…` : text;
  if (text.length > MAX_ENTRY_LENGTH) return `${shown} is too long for an address or range`;
  if (text.toLowerCase() === 'localhost') return undefined;
  const parts = text.split('/');
  if (parts.length > 2) return `${shown} is not an address or range`;
  const family = ipFamily(parts[0]);
  if (!family) return `${shown} is not an address or range`;
  if (parts.length === 2) {
    const width = family === 4 ? 32 : 128;
    if (!/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) > width) return `${shown} has a prefix outside 0-${width}`;
  }
  return undefined;
}

/** A list a person typed: at most MAX_ALLOW_ENTRIES valid entries, trimmed and without repeats; else the first problem. */
export function checkAllowList(entries: readonly string[]): { ok: true; entries: string[] } | { ok: false; problem: string } {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of entries) {
    const problem = ipEntryProblem(raw);
    if (problem) return { ok: false, problem };
    const entry = raw.trim();
    if (seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    kept.push(entry);
  }
  if (kept.length > MAX_ALLOW_ENTRIES) return { ok: false, problem: `A list holds at most ${MAX_ALLOW_ENTRIES} addresses or ranges` };
  return { ok: true, entries: kept };
}
