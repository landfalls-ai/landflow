/** The client address behind trusted proxies, and the origin of emailed links. */
import { afterEach, describe, expect, it } from 'vitest';

const { clientAddress, resetClientAddressWarning } = await import('@/lib/server/net/client-address');
const { callerIp } = await import('@/lib/server/webhook-auth');
const { clientIp } = await import('@/lib/server/auth/rate-limit');
const { publicOrigin, emailedOrigin } = await import('@/lib/server/auth/cookies');

const saved = { ...process.env };
afterEach(() => {
  for (const key of ['LANDFLOW_TRUSTED_PROXIES', 'LANDFLOW_PUBLIC_URL', 'LANDFLOW_PROFILE']) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetClientAddressWarning();
});

const req = (headers: Record<string, string>, url = 'http://host.test/x') => new Request(url, { headers });

describe('clientAddress', () => {
  it('with no proxies takes the last entry (a forged leading entry is ignored)', () => {
    expect(clientAddress(req({ 'x-forwarded-for': '6.6.6.6, 10.0.0.9' }))).toBe('10.0.0.9');
    expect(clientAddress(req({ 'x-forwarded-for': '10.0.0.9' }))).toBe('10.0.0.9');
    expect(clientAddress(req({}))).toBe('local');
  });

  it('ignores X-Real-IP without proxies', () => {
    expect(clientAddress(req({ 'x-real-ip': '6.6.6.6' }))).toBe('local');
  });

  it('with N proxies takes the entry N from the end, the leftmost when the list is short', () => {
    process.env.LANDFLOW_TRUSTED_PROXIES = '1';
    expect(clientAddress(req({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 10.0.0.1' }))).toBe('10.0.0.1');
    process.env.LANDFLOW_TRUSTED_PROXIES = '2';
    expect(clientAddress(req({ 'x-forwarded-for': '6.6.6.6, 1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
    process.env.LANDFLOW_TRUSTED_PROXIES = '3';
    expect(clientAddress(req({ 'x-forwarded-for': '1.2.3.4, 10.0.0.1' }))).toBe('1.2.3.4');
  });

  it('accepts X-Real-IP only with proxies, and only when X-Forwarded-For is absent', () => {
    process.env.LANDFLOW_TRUSTED_PROXIES = '1';
    expect(clientAddress(req({ 'x-real-ip': '9.9.9.9' }))).toBe('9.9.9.9');
  });

  it('strips ports and brackets and maps ::ffff: addresses to IPv4', () => {
    expect(clientAddress(req({ 'x-forwarded-for': '1.2.3.4:5555' }))).toBe('1.2.3.4');
    expect(clientAddress(req({ 'x-forwarded-for': '[2001:db8::1]:443' }))).toBe('2001:db8::1');
    expect(clientAddress(req({ 'x-forwarded-for': '[::1]' }))).toBe('::1');
    expect(clientAddress(req({ 'x-forwarded-for': '::ffff:10.1.2.3' }))).toBe('10.1.2.3');
  });

  it('feeds clientIp and callerIp', () => {
    process.env.LANDFLOW_TRUSTED_PROXIES = '1';
    const r = req({ 'x-forwarded-for': '6.6.6.6, ::ffff:1.2.3.4' });
    expect(clientIp(r)).toBe('1.2.3.4');
    expect(callerIp(r)).toBe('1.2.3.4');
    expect(callerIp(req({}))).toBe('127.0.0.1');
  });
});

describe('publicOrigin', () => {
  const forged = { 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'https' };

  it('prefers LANDFLOW_PUBLIC_URL', () => {
    process.env.LANDFLOW_PUBLIC_URL = 'https://app.example.com/';
    expect(publicOrigin(req(forged))).toBe('https://app.example.com');
  });

  it('uses forwarded headers only behind trusted proxies', () => {
    delete process.env.LANDFLOW_PUBLIC_URL;
    expect(publicOrigin(req(forged))).toBe('http://host.test');
    process.env.LANDFLOW_TRUSTED_PROXIES = '1';
    expect(publicOrigin(req(forged))).toBe('https://evil.test');
  });

  it('refuses emailed links in production without LANDFLOW_PUBLIC_URL', () => {
    delete process.env.LANDFLOW_PUBLIC_URL;
    process.env.LANDFLOW_PROFILE = 'production';
    expect(() => emailedOrigin(req(forged))).toThrow('Set LANDFLOW_PUBLIC_URL to send links');
    process.env.LANDFLOW_PUBLIC_URL = 'https://app.example.com';
    expect(emailedOrigin(req(forged))).toBe('https://app.example.com');
    process.env.LANDFLOW_PROFILE = 'development';
    delete process.env.LANDFLOW_PUBLIC_URL;
    expect(emailedOrigin(req({}))).toBe('http://host.test');
  });
});
