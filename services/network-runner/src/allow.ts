/**
 * The runner's own outbound rule (FR-5, C29-D5). `LANDFLOW_RUNNER_ALLOW` lists what this runner may reach: host names
 * (`inside.office`), `host:port`, addresses and CIDR ranges (`10.20.0.0/16`, `fd00::/8`), `[v6]:port`. The host that
 * sends the calls can't widen it. An empty list refuses everything. A name entry matches the name asked for; an address
 * or range entry matches the address it resolves to (checked when the connection is made, so a name can't resolve to
 * somewhere else after the check) and on every redirect hop.
 */
import { BlockList, isIP } from 'node:net';

export interface AllowEntry {
  text: string;
  /** Lower-cased host name (name entries). */
  name?: string;
  /** The address or range (address and CIDR entries). */
  list?: BlockList;
  port?: number;
}

const unmap = (address: string) => (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address);

function parseOne(text: string): AllowEntry {
  const bad = () => new Error(`LANDFLOW_RUNNER_ALLOW: “${text}” is not a host name, address or CIDR range`);
  let rest = text;
  let port: number | undefined;
  const bracket = /^\[([^\]]+)\](?::(\d+))?(\/\d+)?$/.exec(text);
  if (bracket) {
    rest = bracket[1] + (bracket[3] ?? '');
    if (bracket[2]) port = Number(bracket[2]);
  } else if (!text.includes('/') && (text.match(/:/g) ?? []).length === 1) {
    const at = text.lastIndexOf(':');
    rest = text.slice(0, at);
    port = Number(text.slice(at + 1));
    if (!/^\d+$/.test(text.slice(at + 1))) throw bad();
  }
  if (port !== undefined && !(Number.isInteger(port) && port >= 1 && port <= 65535)) throw bad();
  const [base, prefix] = rest.split('/');
  const family = isIP(base);
  if (!family) {
    if (prefix !== undefined || !/^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i.test(base)) throw bad();
    return { text, name: base.toLowerCase(), ...(port && { port }) };
  }
  const width = family === 4 ? 32 : 128;
  const bits = prefix === undefined ? width : Number(prefix);
  if (!/^\d*$/.test(prefix ?? '') || !Number.isInteger(bits) || bits < 0 || bits > width) throw bad();
  const list = new BlockList();
  if (prefix === undefined) list.addAddress(base, family === 4 ? 'ipv4' : 'ipv6');
  else list.addSubnet(base, bits, family === 4 ? 'ipv4' : 'ipv6');
  return { text, list, ...(port && { port }) };
}

export function parseAllow(value: string | undefined): AllowEntry[] {
  return (value ?? '')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(parseOne);
}

function listHas(list: BlockList, address: string): boolean {
  const plain = unmap(address);
  const family = isIP(plain);
  return family !== 0 && list.check(plain, family === 4 ? 'ipv4' : 'ipv6');
}

/** Whether `address` (a resolved IP) is inside an address or range entry. */
export function addressAllowed(entries: readonly AllowEntry[], address: string, port?: number): boolean {
  return entries.some((entry) => entry.list && (entry.port === undefined || entry.port === port) && listHas(entry.list, address));
}

/** Whether the target `host:port` as asked for (a name or an address literal) may be reached. */
export function targetAllowed(entries: readonly AllowEntry[], host: string, port: number): boolean {
  const bare = host.replace(/^\[|\]$/g, '');
  if (isIP(bare)) return addressAllowed(entries, bare, port);
  const lower = bare.toLowerCase();
  return entries.some((entry) => entry.name === lower && (entry.port === undefined || entry.port === port));
}

/** The name entry that allows `host:port` (a name entry allows whatever the name resolves to). */
export const nameAllowed = (entries: readonly AllowEntry[], host: string, port: number): boolean => !isIP(host.replace(/^\[|\]$/g, '')) && targetAllowed(entries, host, port);
