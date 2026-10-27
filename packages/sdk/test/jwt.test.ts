/** RS256 / GitHub App JWTs: signatures verified with node:crypto against the public half of a key generated at test time. */
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { githubAppJwt, rs256Sign } from '../src/jwt';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const pkcs1 = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;
const pub = publicKey.export({ type: 'spki', format: 'pem' });
const part = (token: string, i: number) => JSON.parse(Buffer.from(token.split('.')[i], 'base64url').toString());
const verifies = (token: string) => {
  const [head, body, sig] = token.split('.');
  return createVerify('RSA-SHA256').update(`${head}.${body}`).verify(pub, Buffer.from(sig, 'base64url'));
};

describe('jwt', () => {
  it('signs RS256 with either key format', () => {
    for (const key of [pkcs8, pkcs1]) {
      const token = rs256Sign(key, { sub: 'x' }, { kid: 'k1' });
      expect(part(token, 0)).toEqual({ typ: 'JWT', kid: 'k1', alg: 'RS256' });
      expect(part(token, 1)).toEqual({ sub: 'x' });
      expect(verifies(token)).toBe(true);
      expect(verifies(`${token}0`)).toBe(false);
    }
  });

  it('builds the GitHub App claims', () => {
    const token = githubAppJwt(98765, pkcs1, 1_760_000_000);
    expect(part(token, 1)).toEqual({ iat: 1_760_000_000 - 60, exp: 1_760_000_000 + 540, iss: '98765' });
    expect(verifies(token)).toBe(true);
  });

  it('accepts escaped newlines and a whitespace-collapsed key, and refuses junk', () => {
    expect(verifies(rs256Sign(pkcs1.trim().replace(/\n/g, '\\n'), { a: 1 }))).toBe(true);
    expect(verifies(rs256Sign(pkcs8.trim().replace(/\n/g, ' '), { a: 1 }))).toBe(true);
    expect(() => rs256Sign('nope', {})).toThrow(/not PEM/);
    expect(() => rs256Sign('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAAA\n-----END ENCRYPTED PRIVATE KEY-----', {})).toThrow(/encrypted/);
  });
});
