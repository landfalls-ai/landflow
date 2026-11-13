/** API rate limits: per principal and per public trigger group and address, 429 + Retry-After, exclusions, off in development. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiLimit, limitRequest, localKeyCount, MAX_LOCAL_KEYS } from '@/lib/server/rate-limit/api-limiter';

const req = (path: string, ip = '10.0.0.1') => new Request(`http://localhost${path}`, { headers: { 'x-forwarded-for': ip } });
const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe('API rate limits', () => {
  it('are off in the development profile', async () => {
    expect(apiLimit('api')).toBe(0);
    expect(apiLimit('public')).toBe(0);
    for (let i = 0; i < 50; i += 1) expect(await limitRequest(req('/api/workflows'), 'u-off')).toBeUndefined();
  });

  it('default to 600 and 120 a minute in production', () => {
    process.env.LANDFLOW_PROFILE = 'production';
    expect(apiLimit('api')).toBe(600);
    expect(apiLimit('public')).toBe(120);
  });

  it('count a principal, answer 429 with Retry-After, and keep principals apart', async () => {
    process.env.LANDFLOW_RATE_LIMIT_API = '3';
    const now = 1_000_000 * 60_000 + 5_000;
    for (let i = 0; i < 3; i += 1) expect(await limitRequest(req('/api/workflows'), 'u-a', now)).toBeUndefined();
    const refused = await limitRequest(req('/api/workflows'), 'u-a', now);
    expect(refused?.status).toBe(429);
    expect(refused?.headers.get('retry-after')).toBe('55');
    expect(await limitRequest(req('/api/workflows'), 'u-b', now)).toBeUndefined();
    // The next window starts afresh.
    expect(await limitRequest(req('/api/workflows'), 'u-a', now + 60_000)).toBeUndefined();
  });

  it('count public triggers per group and client address', async () => {
    process.env.LANDFLOW_RATE_LIMIT_PUBLIC = '2';
    const now = 2_000_000 * 60_000;
    for (let i = 0; i < 2; i += 1) expect(await limitRequest(req('/api/webhook/abc'), undefined, now)).toBeUndefined();
    expect((await limitRequest(req('/api/webhook/abc'), undefined, now))?.status).toBe(429);
    expect(await limitRequest(req('/api/webhook/abc', '10.0.0.2'), undefined, now)).toBeUndefined();
    expect(await limitRequest(req('/form/abc'), undefined, now)).toBeUndefined();
    // Public paths that aren't triggers are not counted.
    expect(await limitRequest(req('/api/auth/oidc'), undefined, now)).toBeUndefined();
  });

  it('never count health checks, plugin heartbeats and metrics', async () => {
    process.env.LANDFLOW_RATE_LIMIT_API = '1';
    process.env.LANDFLOW_RATE_LIMIT_PUBLIC = '1';
    const now = 3_000_000 * 60_000;
    for (const path of ['/api/health', '/api/health/ready', '/api/plugins/announce', '/api/metrics']) {
      for (let i = 0; i < 4; i += 1) {
        expect(await limitRequest(req(path), 'u-x', now), path).toBeUndefined();
        expect(await limitRequest(req(path), undefined, now), path).toBeUndefined();
      }
    }
  });

  it('keep at most MAX_LOCAL_KEYS keys in one window, however many addresses are forged', async () => {
    process.env.LANDFLOW_RATE_LIMIT_PUBLIC = '5';
    const now = 4_000_000 * 60_000;
    for (let i = 0; i < MAX_LOCAL_KEYS + 50; i += 1) await limitRequest(req('/api/webhook/abc', `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`), undefined, now);
    expect(localKeyCount()).toBeLessThanOrEqual(MAX_LOCAL_KEYS);
  });

  it('are applied by handler(): 429 for a principal and for a public trigger, never for health', async () => {
    // handler() reads the real clock: freeze Date so the calls can't straddle a minute boundary and land in two windows.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Math.floor(Date.now() / 60_000) * 60_000 + 1_000);
    try {
      const executions = await import('@/app/api/executions/route');
      const webhook = await import('@/app/api/webhook/[...path]/route');
      const health = await import('@/app/api/health/route');
      const ctx = { params: Promise.resolve({ path: ['nothing-here'] }) };
      process.env.LANDFLOW_RATE_LIMIT_API = '2';
      const list = () => executions.GET(new Request('http://localhost/api/executions?limit=1'));
      expect((await list()).status).toBe(200);
      expect((await list()).status).toBe(200);
      const refused = await list();
      expect(refused.status).toBe(429);
      expect(refused.headers.get('retry-after')).toBeTruthy();

      process.env.LANDFLOW_RATE_LIMIT_PUBLIC = '1';
      const hook = () => webhook.POST(new Request('http://localhost/api/webhook/nothing-here', { method: 'POST', headers: { 'x-forwarded-for': '10.9.9.9' } }), ctx);
      expect((await hook()).status).not.toBe(429);
      const limited = await hook();
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();

      process.env.LANDFLOW_RATE_LIMIT_API = '1';
      for (let i = 0; i < 4; i += 1) expect((await health.GET(new Request('http://localhost/api/health'))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });
});
