/**
 * Classifying IP addresses for the outbound guard (./safe-fetch): which ones a server-side request must not reach
 * (loopback, private, link-local, CGNAT, metadata, ...) and CIDR matching for the allow list.
 * IPv4-mapped (`::ffff:a.b.c.d`, also in its hex form), NAT64 (`64:ff9b::/96`), IPv4-compatible (`::a.b.c.d`) and 6to4
 * (`2002:aabb:ccdd::/48`) addresses are judged by the IPv4 address they carry, so `::ffff:127.0.0.1` is loopback like
 * `127.0.0.1`. The local-use NAT64 prefix `64:ff9b:1::/48` (where the IPv4 part sits depends on the operator's prefix
 * length) is reserved.
 */
import { isIP } from 'node:net';

export type AddressKind = 'public' | 'loopback' | 'private' | 'link-local' | 'cgnat' | 'unspecified' | 'multicast' | 'broadcast' | 'metadata' | 'reserved';

function ipv4Bits(ip: string): bigint {
  return ip.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part) & 255), 0n);
}

/** The 128 bits of an IPv6 address (dotted tails allowed), or undefined when it is not one. */
function ipv6Bits(ip: string): bigint | undefined {
  let address = ip.toLowerCase().replace(/%.*$/, '');
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

/** `[::1]` as a URL host gives `::1`: brackets and a zone id removed. */
export const stripBrackets = (host: string): string => host.replace(/^\[|\]$/g, '').replace(/%.*$/, '');

const dotted = (value: bigint): string => {
  const n = Number(value & 0xffffffffn);
  return [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
};

/** The IPv4 address (as dotted text) an IPv6 address carries (mapped, NAT64, IPv4-compatible or 6to4), when it carries one. */
function embeddedV4(bits: bigint): string | undefined {
  const high96 = bits >> 32n;
  // `::` and `::1` are IPv6's own unspecified and loopback addresses, not IPv4-compatible ones.
  if (high96 === 0xffffn || high96 === 0x0064ff9b0000000000000000n || (high96 === 0n && bits > 1n)) return dotted(bits);
  if (bits >> 112n === 0x2002n) return dotted(bits >> 80n); // 6to4: the IPv4 address follows the 2002::/16 prefix
  return undefined;
}

const inV4 = (bits: bigint, base: string, prefix: number): boolean => bits >> BigInt(32 - prefix) === ipv4Bits(base) >> BigInt(32 - prefix);

function classifyV4(ip: string): AddressKind {
  const bits = ipv4Bits(ip);
  if (ip === '169.254.169.254') return 'metadata';
  if (bits === 0xffffffffn) return 'broadcast';
  if (inV4(bits, '127.0.0.0', 8)) return 'loopback';
  if (inV4(bits, '0.0.0.0', 8)) return 'unspecified';
  if (inV4(bits, '10.0.0.0', 8) || inV4(bits, '172.16.0.0', 12) || inV4(bits, '192.168.0.0', 16)) return 'private';
  if (inV4(bits, '169.254.0.0', 16)) return 'link-local';
  if (inV4(bits, '100.64.0.0', 10)) return 'cgnat';
  if (inV4(bits, '224.0.0.0', 4)) return 'multicast';
  if (inV4(bits, '240.0.0.0', 4) || inV4(bits, '192.0.0.0', 24) || inV4(bits, '198.18.0.0', 15)) return 'reserved';
  return 'public';
}

/** What kind of address `ip` is (`public` for everything a request may reach). Not an IP address: `reserved`. */
export function classifyAddress(ip: string): AddressKind {
  const text = stripBrackets(ip);
  const family = isIP(text);
  if (family === 4) return classifyV4(text);
  if (family !== 6) return 'reserved';
  const bits = ipv6Bits(text);
  if (bits === undefined) return 'reserved';
  const v4 = embeddedV4(bits);
  if (v4) return classifyV4(v4);
  if (bits === 0n) return 'unspecified';
  if (bits === 1n) return 'loopback';
  if (bits === ipv6Bits('fd00:ec2::254')) return 'metadata';
  if (bits >> 80n === 0x64ff9b0001n) return 'reserved'; // 64:ff9b:1::/48, local-use NAT64
  if (bits >> 121n === 0x7en) return 'private'; // fc00::/7
  if (bits >> 118n === 0x3fan) return 'link-local'; // fe80::/10
  if (bits >> 120n === 0xffn) return 'multicast';
  return 'public';
}

/** Whether a request to this address is refused by default. */
export const isBlockedAddress = (ip: string): boolean => classifyAddress(ip) !== 'public';

/** Whether `ip` is the address or inside the CIDR range `entry` (`10.0.0.0/8`, `fd00::/8`, `127.0.0.1`); a mapped v6 address matches a v4 entry. */
export function addressInRange(ip: string, entry: string): boolean {
  const [rangeText, prefixText] = entry.trim().split('/');
  const range = stripBrackets(rangeText);
  const family = isIP(range);
  if (!family) return false;
  let text = stripBrackets(ip);
  if (isIP(text) === 6 && family === 4) {
    const v6 = ipv6Bits(text);
    const v4 = v6 === undefined ? undefined : embeddedV4(v6);
    if (!v4) return false;
    text = v4;
  }
  if (isIP(text) !== family) return false;
  const width = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? width : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return false;
  const bits = (value: string) => (family === 4 ? ipv4Bits(value) : (ipv6Bits(value) ?? -1n));
  const a = bits(text);
  const b = bits(range);
  if (a < 0n || b < 0n) return false;
  const shift = BigInt(width - prefix);
  return a >> shift === b >> shift;
}
