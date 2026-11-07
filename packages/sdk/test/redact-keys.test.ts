import { describe, expect, it } from 'vitest';
import { SECRET_KEY } from '../src/redact';

describe('SECRET_KEY', () => {
  it('masks secrets but not usage counts or addresses', () => {
    for (const key of ['accessToken', 'api_key', 'password', 'authorization', 'client_secret']) expect(SECRET_KEY.test(key)).toBe(true);
    for (const key of ['tokenUrl', 'tokenType', 'gen_ai.usage.input_tokens', 'gen_ai.usage.output_tokens', 'max_tokens']) expect(SECRET_KEY.test(key)).toBe(false);
  });
});
