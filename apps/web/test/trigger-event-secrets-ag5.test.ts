/**
 * Wave ag5 fix pass: the last trigger event a session tests with drops more secrets (docs/assistant.md "Test and fix"): the
 * authorization and cookie headers it dropped already, and now signature, token and secret headers and secret-looking query
 * parameters. What is test data (the body, the other headers and parameters) stays.
 */
import { describe, expect, it } from 'vitest';
import { withoutSecrets } from '@/components/editor/fix-session';

describe('withoutSecrets', () => {
  it('drops signature, token and secret headers and secret-looking query parameters; keeps the rest', () => {
    const out = withoutSecrets({
      body: { report: 'x' },
      headers: { 'content-type': 'application/json', authorization: 'Bearer a', cookie: 'c', 'x-hub-signature-256': 'sha256=1', 'stripe-signature': 't=1', 'x-webhook-secret': 's', 'x-github-token': 't', 'x-slack-request-timestamp': '1', 'x-request-id': 'r' },
      query: { month: 'october', token: 't', api_key: 'k', apikey: 'k', secret: 's', signature: 'g', password: 'p', access_token: 'a', page: '2' },
    });
    expect(out.headers).toEqual({ 'content-type': 'application/json', 'x-slack-request-timestamp': '1', 'x-request-id': 'r' });
    expect(out.query).toEqual({ month: 'october', page: '2' });
    expect(out.body).toEqual({ report: 'x' });
  });

  it('also drops x-signature-*, *hmac*, x-amz-* and authorization* headers, the query parameters code, sig, signature and x-amz-*, and a top-level body token, verification_token, secret or password; keeps author', () => {
    const out = withoutSecrets({
      headers: { 'x-signature-ed25519': 'a', 'x-body-hmac': 'b', 'x-amz-security-token': 'c', 'x-amz-date': 'd', 'authorization-extra': 'e', author: 'ann', 'x-request-id': 'r' },
      query: { code: '1', sig: '2', signature: '3', 'x-amz-signature': '4', 'X-Amz-Credential': '5', author: 'ann', month: 'october' },
      body: { token: 't', verification_token: 'v', secret: 's', password: 'p', Password: 'q', author: 'ann', nested: { token: 'kept: not top level' }, report: 'x' },
    });
    expect(out.headers).toEqual({ author: 'ann', 'x-request-id': 'r' });
    expect(out.query).toEqual({ author: 'ann', month: 'october' });
    expect(out.body).toEqual({ author: 'ann', nested: { token: 'kept: not top level' }, report: 'x' });
  });

  it('an event with no headers or query is unchanged', () => {
    expect(withoutSecrets({ a: 1 })).toEqual({ a: 1 });
  });
});
