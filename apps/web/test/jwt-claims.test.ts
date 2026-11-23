/**
 * Bound claims for JWT Auth credentials (lib/server/jwt-claims.ts): the text format, the glob, which credentials count
 * as public CI issuers, the check itself, and the credential's Test button (nodes/credentials.ts).
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-jwt-claims-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const { parseBoundClaims, matchesGlob, isPublicCiIssuer, checkBoundClaims, claimsRequiredMessage } = await import('@/lib/server/jwt-claims');
const { jwtAuthCredential } = await import('@/lib/server/nodes/credentials');

const GITHUB = 'https://token.actions.githubusercontent.com';
const GITHUB_JWKS = 'https://token.actions.githubusercontent.com/.well-known/jwks';

describe('parseBoundClaims', () => {
  it('reads one claim: pattern per line, skipping comments and blank lines', () => {
    const { claims, problems } = parseBoundClaims('# who may call\nrepository: my-org/app\n\n  ref:refs/heads/main  \nsub: repo:my-org/app:ref:refs/heads/*\n');
    expect(problems).toEqual([]);
    expect(claims).toEqual([
      { claim: 'repository', pattern: 'my-org/app' },
      { claim: 'ref', pattern: 'refs/heads/main' },
      { claim: 'sub', pattern: 'repo:my-org/app:ref:refs/heads/*' },
    ]);
  });

  it('names a bad line by its number', () => {
    const { problems } = parseBoundClaims('repository: my-org/app\nnot a claim\nref:');
    expect(problems).toEqual(['line 2: expected “claim: pattern”', 'line 3: expected “claim: pattern”']);
  });
});

describe('matchesGlob', () => {
  it('matches exact values and a * within one segment', () => {
    expect(matchesGlob('my-org/app', 'my-org/app')).toBe(true);
    expect(matchesGlob('my-org/app', 'my-org/app2')).toBe(false);
    expect(matchesGlob('repo:my-org/app:ref:refs/heads/*', 'repo:my-org/app:ref:refs/heads/main')).toBe(true);
    expect(matchesGlob('repo:my-org/app:ref:refs/heads/*', 'repo:my-org/app:pull_request')).toBe(false);
    expect(matchesGlob('repo:my-org/app:ref:refs/heads/*', 'repo:my-org/app:ref:refs/heads/a/b')).toBe(false);
    expect(matchesGlob('my-org/*', 'my-org/anything')).toBe(true);
    expect(matchesGlob('my-org/*', 'other/anything')).toBe(false);
  });

  it('treats every other character literally (no regex)', () => {
    expect(matchesGlob('my.org/app', 'myxorg/app')).toBe(false);
    expect(matchesGlob('a+b', 'a+b')).toBe(true);
    expect(matchesGlob('(x)', 'x')).toBe(false);
  });
});

describe('isPublicCiIssuer', () => {
  it('recognises the issuer, the JWKS host and the verified iss (any one)', () => {
    expect(isPublicCiIssuer({ keyType: 'jwks', issuer: GITHUB })).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'jwks', issuer: `${GITHUB}/` })).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'jwks', issuer: 'https://gitlab.com' })).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'jwks', jwksUrl: GITHUB_JWKS })).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'jwks', jwksUrl: 'https://gitlab.com/oauth/discovery/keys' })).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'pemKey' }, GITHUB)).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'jwks', issuer: `${GITHUB}/my-enterprise` })).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'jwks', issuer: 'https://token.actions.githubusercontent.com./' })).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'jwks', jwksUrl: 'https://TOKEN.actions.githubusercontent.com./.well-known/jwks' })).toBe(true);
    expect(isPublicCiIssuer({ keyType: 'jwks', issuer: 'https://token.actions.acme.ghe.com' })).toBe(true);
  });

  it('leaves other issuers alone', () => {
    expect(isPublicCiIssuer({ keyType: 'jwks', issuer: 'https://issuer.example', jwksUrl: 'https://issuer.example/jwks' })).toBe(false);
    expect(isPublicCiIssuer({ keyType: 'passphrase', secret: 'x' })).toBe(false);
    expect(isPublicCiIssuer({ keyType: 'jwks', jwksUrl: 'https://evil.example/token.actions.githubusercontent.com' })).toBe(false);
  });
});

describe('checkBoundClaims', () => {
  const github = { keyType: 'jwks', jwksUrl: GITHUB_JWKS, issuer: GITHUB };

  it('requires a binding claim of a CI credential', () => {
    expect(checkBoundClaims(github, { iss: GITHUB })).toMatchObject({ ok: false, reason: 'claims_required' });
    expect(checkBoundClaims({ ...github, boundClaims: 'ref: refs/heads/main' }, { iss: GITHUB })).toMatchObject({ ok: false, reason: 'claims_required' });
    // A pattern that starts with * matches every repository: not a binding.
    expect(checkBoundClaims({ ...github, boundClaims: 'repository: *' }, { iss: GITHUB, repository: 'x/y' })).toMatchObject({ ok: false, reason: 'claims_required' });
    expect(checkBoundClaims({ ...github, boundClaims: 'repository: */app' }, { iss: GITHUB, repository: 'x/app' })).toMatchObject({ ok: false, reason: 'claims_required' });
  });

  it('wants a literal owner in a binding', () => {
    const weak = [
      'sub: repo:*/*:ref:refs/heads/main',
      'sub: *',
      'sub: repo:e*/app:ref:refs/heads/main',
      'repository: e*/*',
      'repository: my-org*/app',
      'repository: my-org',
      'repository_id: *',
      'project_path: grp*/x',
      'sub: project_path:*/*:ref_type:branch:ref:main',
      'repository_owner_id: 1*',
    ];
    for (const boundClaims of weak) expect(checkBoundClaims({ ...github, boundClaims }, { iss: GITHUB }), boundClaims).toMatchObject({ ok: false, reason: 'claims_required' });
    const strong = ['repository: my-org/*', 'repository: my-org/app', 'sub: repo:my-org/*', 'sub: project_path:grp/x:ref_type:branch:ref:main', 'project_path: grp/*', 'repository_id: 123456', 'repository_owner_id: 42', 'project_id: 9', 'namespace_id: 3'];
    for (const boundClaims of strong) expect(checkBoundClaims({ ...github, boundClaims }, { iss: GITHUB }), boundClaims).not.toMatchObject({ reason: 'claims_required' });
  });

  it('answers claim_mismatch with the claim name', () => {
    const credential = { ...github, boundClaims: 'repository: my-org/app\nref: refs/heads/*' };
    expect(checkBoundClaims(credential, { repository: 'my-org/app', ref: 'refs/heads/main' })).toEqual({ ok: true });
    expect(checkBoundClaims(credential, { repository: 'other/app', ref: 'refs/heads/main' })).toEqual({ ok: false, reason: 'claim_mismatch', claim: 'repository' });
    expect(checkBoundClaims(credential, { repository: 'my-org/app' })).toEqual({ ok: false, reason: 'claim_mismatch', claim: 'ref' });
    expect(checkBoundClaims(credential, { repository: 'my-org/app', ref: 7 })).toEqual({ ok: false, reason: 'claim_mismatch', claim: 'ref' });
  });

  it('matches an array claim when any element matches', () => {
    const credential = { keyType: 'jwks', jwksUrl: 'https://issuer.example/jwks', boundClaims: 'groups: ops' };
    expect(checkBoundClaims(credential, { groups: ['dev', 'ops'] })).toEqual({ ok: true });
    expect(checkBoundClaims(credential, { groups: ['dev'] })).toEqual({ ok: false, reason: 'claim_mismatch', claim: 'groups' });
  });

  it('leaves a non-CI credential with no bound claims as it was', () => {
    expect(checkBoundClaims({ keyType: 'passphrase', secret: 's' }, { sub: 'u' })).toEqual({ ok: true });
  });

  it('reports a credential whose text does not parse', () => {
    expect(checkBoundClaims({ keyType: 'passphrase', boundClaims: 'oops' }, {})).toMatchObject({ ok: false, reason: 'claims_invalid' });
  });

  it('says exactly what to add and where', () => {
    expect(claimsRequiredMessage()).toMatch(/Bound Claims/);
    expect(claimsRequiredMessage()).toMatch(/repository: my-org\/my-repo/);
  });
});

describe('the JWT Auth credential', () => {
  const test = (data: Record<string, unknown>, fetcher?: (url: string) => Promise<Response>) =>
    jwtAuthCredential.test!(data, { http: fetcher ?? (async () => new Response('{}')) } as never);

  it('has a Bound Claims property', () => {
    expect(jwtAuthCredential.properties.find((p) => p.name === 'boundClaims')).toMatchObject({ displayName: 'Bound Claims', type: 'string' });
  });

  it('refuses a GitHub credential with no bound claim, with the words to fix it', async () => {
    const result = await test({ keyType: 'jwks', jwksUrl: GITHUB_JWKS, issuer: GITHUB });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Bound Claims/);
    expect(result.message).toMatch(/repository: my-org\/my-repo/);
  });

  it('names a bad line', async () => {
    const result = await test({ keyType: 'passphrase', secret: 's', boundClaims: 'repository: a/b\nwat' });
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toMatch(/line 2/);
  });

  it('reports the key count of a JWKS URL', async () => {
    const result = await test(
      { keyType: 'jwks', jwksUrl: 'https://issuer.example/jwks', boundClaims: 'groups: ops' },
      async () => new Response(JSON.stringify({ keys: [{ kid: 'a' }, { kid: 'b' }] })),
    );
    expect(result).toMatchObject({ ok: true });
    expect(result.message).toMatch(/2 keys/);
  });

  it('fetches the JWKS without following redirects and reads a capped body', async () => {
    let init: RequestInit | undefined;
    const result = await test({ keyType: 'jwks', jwksUrl: 'https://issuer.example/jwks', boundClaims: 'groups: ops' }, async (_url, i) => {
      init = i;
      return new Response('x'.repeat(2_000_000));
    });
    expect(init?.redirect).toBe('manual');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/too large|key set/);
  });

  it('warns that a sub pattern ending in :* never matches', async () => {
    const result = await test({ keyType: 'passphrase', secret: 's', boundClaims: 'sub: repo:my-org/app:*' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/:\*/);
  });

  it('passes a plain secret credential', async () => {
    expect(await test({ keyType: 'passphrase', secret: 's' })).toMatchObject({ ok: true });
  });
});

describe('the shared bound-claims parser (C18 W4a)', () => {
  it('round-trips through formatBoundClaims and is the parser the server re-exports', async () => {
    const shared = await import('@/lib/shared/bound-claims');
    const text = '# who may call\nrepository: my-org/app\nsub: repo:my-org/app:ref:refs/heads/*';
    const parsed = shared.parseBoundClaims(text);
    expect(parsed.problems).toEqual([]);
    expect(shared.formatBoundClaims(parsed.claims)).toBe('repository: my-org/app\nsub: repo:my-org/app:ref:refs/heads/*');
    expect(shared.parseBoundClaims(shared.formatBoundClaims(parsed.claims)).claims).toEqual(parsed.claims);
    expect(parseBoundClaims).toBe(shared.parseBoundClaims);
  });

  it('imports nothing from the server', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(join(process.cwd(), 'src/lib/shared/bound-claims.ts'), 'utf8');
    expect(source).not.toMatch(/from '[^']*server/);
  });
});
