/**
 * IP allow-lists: the address and CIDR matching webhook triggers and API keys share (it lived in webhook-auth.ts, which
 * auth code should not import). `callerIp` is the request's address by the trusted-proxy rules of ./client-address
 * (never a header read here); entries are IPv4/IPv6 addresses, CIDR ranges and `localhost`; an IPv4-mapped IPv6
 * address (`::ffff:10.1.2.3`) is the IPv4 address, on either side of a match. `ipEntryProblem` and `checkAllowList`
 * validate what a person typed, with a message that names the entry.
 */
import { isIP } from 'node:net';
import { checkAllowList, ipEntryProblem, MAX_ALLOW_ENTRIES } from '../../shared/ip-entry';
import { clientAddress } from './client-address';

// Validation of a typed list lives in shared/ip-entry.ts (the settings form uses it too); re-exported for the server.
export { checkAllowList, ipEntryProblem, MAX_ALLOW_ENTRIES };

/** The caller's address, from the trusted-proxy rules in ./client-address; 127.0.0.1 when no header names one. */
export function callerIp(request: Request): string {
  const ip = clientAddress(request);
  return ip === 'local' ? '127.0.0.1' : ip;
}

/**
 * The address an allow-list is checked against: the request's own (`clientAddress`), or undefined when no header names one
 * (a blank X-Forwarded-For): such a caller is refused, never taken for 127.0.0.1 as webhook triggers do.
 */
export function allowListAddress(request: Request): string | undefined {
  const ip = clientAddress(request);
  return ip === 'local' ? undefined : ip;
}

function ipv4Bits(ip: string): bigint {
  return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part) & 255), 0n);
}

function ipv6Bits(ip: string): bigint | undefined {
  let address = ip.toLowerCase();
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (v4) {
    const bits = ipv4Bits(v4[1]);
    address = `${address.slice(0, -v4[1].length)}${(bits >> 16n).toString(16)}:${(bits & 0xffffn).toString(16)}`;
  }
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined ? (tail ? tail.split(':') : []) : [];
  const groups = tail !== undefined ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  if (groups.length !== 8) return undefined;
  return groups.reduce((acc, group) => (acc << 16n) | BigInt(parseInt(group || '0', 16) & 0xffff), 0n);
}

/** An IPv4-mapped IPv6 address as the IPv4 one (`::ffff:10.1.2.3` is `10.1.2.3`), anything else as it is. */
function unmap(ip: string): string {
  const bits = isIP(ip) === 6 ? ipv6Bits(ip) : undefined;
  if (bits === undefined || bits >> 32n !== 0xffffn) return ip;
  const v4 = bits & 0xffffffffn;
  return [24n, 16n, 8n, 0n].map((shift) => String((v4 >> shift) & 255n)).join('.');
}

/** An entry with an IPv4-mapped range (`::ffff:10.0.0.0/104`) as the IPv4 range, so it matches IPv4 callers. */
function unmapEntry(entry: string): string {
  const [range, prefixText] = entry.trim().split('/');
  if (isIP(range) !== 6) return entry.trim();
  const plain = unmap(range);
  if (plain === range) return entry.trim();
  if (prefixText === undefined) return plain;
  const prefix = Number(prefixText);
  // A mapped range shorter than /96 also covers addresses that are not IPv4 ones: left as it is.
  return Number.isInteger(prefix) && prefix >= 96 && prefix <= 128 ? `${plain}/${prefix - 96}` : entry.trim();
}

/** Whether `ip` matches one entry: an address, or a CIDR range (`10.0.0.0/8`, `2001:db8::/32`). */
export function ipMatches(ip: string, entry: string): boolean {
  const address = unmap(ip.trim());
  const [range, prefixText] = unmapEntry(entry).split('/');
  const family = isIP(range);
  if (!family || isIP(address) !== family) return entry.trim().toLowerCase() === 'localhost' && (address === '127.0.0.1' || address === '::1');
  const width = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? width : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return false;
  const bits = (value: string) => (family === 4 ? ipv4Bits(value) : (ipv6Bits(value) ?? -1n));
  const a = bits(address);
  const b = bits(range);
  if (a < 0n || b < 0n) return false;
  const shift = BigInt(width - prefix);
  return a >> shift === b >> shift;
}

/** The allow-list entries (comma, space or newline separated); empty: everyone. */
export function parseIpList(value: unknown): string[] {
  return String(value ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/** Whether `ip` may pass `entries`: an empty list lets everyone in; a caller with no address passes no list. */
export function allowed(ip: string | undefined, entries: readonly string[]): boolean {
  if (!entries.length) return true;
  if (!ip) return false;
  return entries.some((entry) => ipMatches(ip, entry));
}
