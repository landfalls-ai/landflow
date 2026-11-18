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

  it('an event with no headers or query is unchanged', () => {
    expect(withoutSecrets({ a: 1 })).toEqual({ a: 1 });
  });
});
