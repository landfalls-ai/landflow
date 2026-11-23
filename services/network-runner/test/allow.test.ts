/** The runner's own outbound rule (FR-5, C29-D5): an empty list refuses everything; names, ports and CIDRs (v4 and v6). */
import { describe, expect, it } from 'vitest';
import { addressAllowed, parseAllow, targetAllowed } from '../src/allow';

describe('parseAllow', () => {
  it('reads names, host:port, addresses, CIDRs and [v6]:port, comma or space separated', () => {
    expect(parseAllow('inside.local, 10.20.0.0/16 api.office:8443 [fd00::]:9000 fd00::/8')).toHaveLength(5);
    expect(parseAllow('')).toEqual([]);
  });
  it('rejects a bad CIDR or port with the entry named', () => {
    expect(() => parseAllow('10.0.0.0/40')).toThrow(/10\.0\.0\.0\/40/);
    expect(() => parseAllow('host:99999')).toThrow(/host:99999/);
  });
});

describe('the allow-list', () => {
  it('an empty list refuses everything', () => {
    expect(targetAllowed([], 'example.com', 80)).toBe(false);
    expect(targetAllowed([], '10.20.0.10', 80)).toBe(false);
  });
  it('AS-3: 10.20.0.0/16 allows 10.20.0.10 and refuses 10.30.0.1', () => {
    const list = parseAllow('10.20.0.0/16');
    expect(targetAllowed(list, '10.20.0.10', 80)).toBe(true);
    expect(targetAllowed(list, '10.30.0.1', 80)).toBe(false);
  });
  it('a name entry matches the name (any case), not another name', () => {
    const list = parseAllow('Inside.Office');
    expect(targetAllowed(list, 'inside.office', 443)).toBe(true);
    expect(targetAllowed(list, 'other.office', 443)).toBe(false);
  });
  it('a port restricts the entry', () => {
    const list = parseAllow('inside.office:8443 10.1.0.0/16');
    expect(targetAllowed(list, 'inside.office', 8443)).toBe(true);
    expect(targetAllowed(list, 'inside.office', 80)).toBe(false);
    expect(targetAllowed(list, '10.1.2.3', 80)).toBe(true);
  });
  it('matches resolved addresses against CIDRs only: a name entry does not allow its address range', () => {
    const list = parseAllow('10.20.0.0/16');
    expect(addressAllowed(list, '10.20.5.5')).toBe(true);
    expect(addressAllowed(list, '10.21.0.1')).toBe(false);
  });
  it('IPv6 CIDRs and IPv4-mapped addresses', () => {
    const list = parseAllow('fd00:1::/32 10.0.0.0/8');
    expect(addressAllowed(list, 'fd00:1::5')).toBe(true);
    expect(addressAllowed(list, 'fd00:2::5')).toBe(false);
    expect(addressAllowed(list, '::ffff:10.1.1.1')).toBe(true);
    expect(addressAllowed(list, '::ffff:11.1.1.1')).toBe(false);
  });
});
