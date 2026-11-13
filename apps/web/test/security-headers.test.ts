/** The proxy's security headers and nonce CSP (src/proxy.ts): fixed headers everywhere, frame denial except where embedding is meant. */
import { afterEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';

const BASE = 'http://localhost:3000';
const run = (path: string, headers: Record<string, string> = {}, base = BASE) => proxy(new NextRequest(`${base}${path}`, { headers }));
const signedIn = { cookie: 'landflow_session=abc' };
const CSP = 'content-security-policy';
const ONLY = 'content-security-policy-report-only';

afterEach(() => {
  delete process.env.LANDFLOW_CSP;
  delete process.env.LANDFLOW_HSTS;
  delete process.env.LANDFLOW_PROFILE;
});

describe('security headers', () => {
  it('carry the fixed headers on a page, an API route, a 401 and a redirect', () => {
    const responses = [run('/workflows', signedIn), run('/api/workflows', { authorization: 'Bearer lf_x' }), run('/api/workflows'), run('/workflows')];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 401, 307]);
    for (const res of responses) {
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
      expect(res.headers.get('permissions-policy')).toBe('camera=(), geolocation=(), microphone=(self)');
      expect(res.headers.get('x-frame-options')).toBe('DENY');
    }
  });

  it('leave embeddable and self-policed paths without frame headers or a CSP', () => {
    for (const path of ['/chat/x', '/form/x', '/form-test/x', '/api/binary/x', '/api/mcp/files/x', '/mcp/x', '/api/webhook/x', '/mcp-test/x', '/api/webhook-test/x']) {
      const res = run(path);
      expect(res.headers.get('x-frame-options'), path).toBeNull();
      expect(res.headers.get(CSP), path).toBeNull();
      expect(res.headers.get(ONLY), path).toBeNull();
      expect(res.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
    // A look-alike prefix is not embeddable.
    expect(run('/chatty', signedIn).headers.get('x-frame-options')).toBe('DENY');
  });

  it('send HSTS only over https, and not when LANDFLOW_HSTS=off', () => {
    expect(run('/workflows', signedIn).headers.get('strict-transport-security')).toBeNull();
    const hsts = 'max-age=31536000; includeSubDomains';
    expect(run('/workflows', signedIn, 'https://landflow.example').headers.get('strict-transport-security')).toBe(hsts);
    expect(run('/workflows', { ...signedIn, 'x-forwarded-proto': 'https' }).headers.get('strict-transport-security')).toBe(hsts);
    process.env.LANDFLOW_HSTS = 'off';
    expect(run('/workflows', signedIn, 'https://landflow.example').headers.get('strict-transport-security')).toBeNull();
  });

  it('name the CSP header by mode: report-only in development, enforced in production, none when off', () => {
    process.env.LANDFLOW_PROFILE = 'development';
    let res = run('/workflows', signedIn);
    expect(res.headers.get(CSP)).toBeNull();
    expect(res.headers.get(ONLY)).toContain("frame-ancestors 'none'");
    process.env.LANDFLOW_PROFILE = 'production';
    res = run('/workflows', signedIn);
    expect(res.headers.get(ONLY)).toBeNull();
    expect(res.headers.get(CSP)).toMatch(/script-src 'self' 'nonce-[^']+' 'strict-dynamic'/);
    expect(res.headers.get(CSP)).toContain("object-src 'self' data: https:");
    process.env.LANDFLOW_CSP = 'report';
    res = run('/workflows', signedIn);
    expect(res.headers.get(CSP)).toBeNull();
    expect(res.headers.get(ONLY)).not.toBeNull();
    process.env.LANDFLOW_CSP = 'off';
    res = run('/workflows', signedIn);
    expect(res.headers.get(CSP)).toBeNull();
    expect(res.headers.get(ONLY)).toBeNull();
  });

  it('put no CSP on API routes, and use a fresh nonce per request that Next can read from the request headers', () => {
    process.env.LANDFLOW_CSP = 'enforce';
    expect(run('/api/workflows', signedIn).headers.get(CSP)).toBeNull();
    const nonce = (res: Response) => /'nonce-([^']+)'/.exec(res.headers.get(CSP) ?? '')?.[1];
    const a = run('/workflows', signedIn);
    const b = run('/workflows', signedIn);
    expect(nonce(a)).toBeTruthy();
    expect(nonce(a)).not.toBe(nonce(b));
    expect(a.headers.get('x-middleware-request-x-nonce')).toBe(nonce(a));
    expect(a.headers.get('x-middleware-request-content-security-policy')).toBe(a.headers.get(CSP));
  });
});
