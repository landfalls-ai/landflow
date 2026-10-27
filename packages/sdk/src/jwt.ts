/**
 * RS256 JWTs with `node:crypto`, for services that authenticate a client with a signed token. GitHub Apps sign a short
 * JWT with their private key (PKCS#1 or PKCS#8 PEM) and trade it for an installation token. The Python SDK (`landflow_sdk.jwt`)
 * and the Go SDK (`landflow.GitHubAppJWT`, `landflow.NewGitHubAppTokens`) have the same helpers.
 */
import { createSign } from 'node:crypto';

const b64url = (data: Buffer | string) => Buffer.from(data).toString('base64url');

/** A key pasted into a single-line field keeps literal `\n`s; whitespace-collapsed PEMs are rebuilt. */
function normalizePem(pem: string): string {
  const text = pem.trim().replace(/\\n/g, '\n');
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/.exec(text);
  if (!match) throw new Error('the private key is not PEM (expected -----BEGIN RSA PRIVATE KEY----- or -----BEGIN PRIVATE KEY-----)');
  if (match[1] === 'ENCRYPTED PRIVATE KEY') throw new Error('the private key is encrypted; remove the passphrase first');
  const body = (match[2] ?? '').replace(/\s+/g, '');
  return `-----BEGIN ${match[1]}-----\n${(body.match(/.{1,64}/g) ?? []).join('\n')}\n-----END ${match[1]}-----\n`;
}

/** A compact JWS (`header.payload.signature`) with `alg: RS256`; `headers` adds to `{ alg, typ }`. */
export function rs256Sign(privateKeyPem: string, payload: Record<string, unknown>, headers: Record<string, unknown> = {}): string {
  const signingInput = `${b64url(JSON.stringify({ typ: 'JWT', ...headers, alg: 'RS256' }))}.${b64url(JSON.stringify(payload))}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(normalizePem(privateKeyPem));
  return `${signingInput}.${b64url(signature)}`;
}

/** A GitHub App JWT: `iss` = app id (a client id works too), `iat` = now - 60 s (clock drift), `exp` = now + 540 s (GitHub's limit is ten minutes). `now` is unix seconds. */
export function githubAppJwt(appId: string | number, privateKeyPem: string, now: number = Math.floor(Date.now() / 1000)): string {
  return rs256Sign(privateKeyPem, { iat: Math.floor(now) - 60, exp: Math.floor(now) + 540, iss: String(appId).trim() });
}
