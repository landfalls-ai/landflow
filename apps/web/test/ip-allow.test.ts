/**
 * The IP allow-list helpers (lib/server/net/ip-allow.ts), shared by webhook triggers and API keys: entry validation with
 * a problem that names the entry, the 50-entry cap, duplicates, IPv4-mapped IPv6, and the empty list meaning everyone.
 */
import { describe, expect, it } from 'vitest';

const { allowed, checkAllowList, ipEntryProblem, ipMatches, MAX_ALLOW_ENTRIES, parseIpList } = await import('@/lib/server/net/ip-allow');
const webhook = await import('@/lib/server/webhook-auth');

describe('ipEntryProblem', () => {
  it('accepts addresses, CIDR ranges and localhost', () => {
    for (const ok of ['10.0.0.0/8', '2001:db8::/32', '203.0.113.7', '::1', 'localhost', ' 192.168.1.0/24 ', '::ffff:10.1.2.3']) expect(ipEntryProblem(ok), ok).toBeUndefined();
  });

  it('names the entry it refuses', () => {
    for (const bad of ['300.1.1.1', '10.0.0.0/33', '::/129', 'abc', '10.0.0.0/', '10.0.0.0/-1', '10.0.0.0/8/8', '10.0.0.0/x', '']) {
      const problem = ipEntryProblem(bad);
      expect(problem, bad).toBeTruthy();
      if (bad.trim()) expect(problem).toContain(bad.trim());
    }
  });
});

describe('a range that allows everyone', () => {
  it('is refused with advice, on the server and in the form alike', () => {
    for (const entry of ['0.0.0.0/0', '::/0', '::ffff:0:0/96', '10.0.0.0/0']) expect(ipEntryProblem(entry), entry).toContain('allows every address');
    expect(ipEntryProblem('10.0.0.0/8')).toBeUndefined();
    expect(ipEntryProblem('::ffff:10.0.0.0/104')).toBeUndefined();
  });
});

describe('checkAllowList', () => {
  it('refuses more than 50 entries and names the first bad one', () => {
    const many = Array.from({ length: MAX_ALLOW_ENTRIES + 1 }, (_, i) => `10.0.${Math.floor(i / 250)}.${i % 250}`);
    expect(checkAllowList(many)).toMatchObject({ ok: false });
    expect(checkAllowList(many.slice(0, MAX_ALLOW_ENTRIES)).ok).toBe(true);
    const bad = checkAllowList(['10.0.0.1', '300.1.1.1']);
    expect(bad).toMatchObject({ ok: false });
    expect(!bad.ok && bad.problem).toContain('300.1.1.1');
  });

  it('removes duplicates and trims', () => {
    expect(checkAllowList([' 10.0.0.1 ', '10.0.0.1', 'LOCALHOST', 'localhost'])).toEqual({ ok: true, entries: ['10.0.0.1', 'LOCALHOST'] });
  });
});

describe('allowed', () => {
  it('lets everyone in on an empty list, nobody without an address', () => {
    expect(allowed('1.2.3.4', [])).toBe(true);
    expect(allowed(undefined, ['10.0.0.0/8'])).toBe(false);
    expect(allowed(undefined, [])).toBe(true);
  });

  it('matches ranges and IPv4-mapped IPv6 both ways', () => {
    expect(allowed('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(allowed('192.168.1.5', ['10.0.0.0/8'])).toBe(false);
    expect(allowed('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(allowed('10.1.2.3', ['::ffff:10.1.2.3'])).toBe(true);
    expect(allowed('10.1.2.3', ['::ffff:10.0.0.0/104'])).toBe(true);
    expect(allowed('11.1.2.3', ['::ffff:10.0.0.0/104'])).toBe(false);
    expect(allowed('2001:db8::1', ['2001:db8::/32'])).toBe(true);
    expect(allowed('127.0.0.1', ['localhost'])).toBe(true);
  });
});

describe('allowListAddress', () => {
  it('has no address for a blank X-Forwarded-For, where webhooks take 127.0.0.1', async () => {
    const { allowListAddress, callerIp } = await import('@/lib/server/net/ip-allow');
    const blank = new Request('http://x.test/', { headers: { 'x-forwarded-for': ' ' } });
    expect(allowListAddress(blank)).toBeUndefined();
    expect(callerIp(blank)).toBe('127.0.0.1');
    expect(allowListAddress(new Request('http://x.test/', { headers: { 'x-forwarded-for': '10.1.2.3' } }))).toBe('10.1.2.3');
  });
});

describe('moved helpers', () => {
  it('webhook-auth still exports them', () => {
    expect(webhook.ipMatches).toBe(ipMatches);
    expect(webhook.parseIpList).toBe(parseIpList);
  });
});
