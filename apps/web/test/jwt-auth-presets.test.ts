/**
 * C18 W4a: the JWT Auth credential dialog's helpers (components/credentials/jwt-auth-presets.tsx): the GitHub Actions and
 * GitLab CI presets, and the claims editor that reads and writes the credential's `boundClaims` text.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyJwtPreset, JWT_AUTH_CREDENTIAL, JWT_PRESETS, JwtAuthPresets, claimRowsFromText, textFromClaimRows } from '@/components/credentials/jwt-auth-presets';
import { parseBoundClaims } from '@/lib/shared/bound-claims';

const preset = (id: string) => JWT_PRESETS.find((p) => p.id === id)!;

describe('presets', () => {
  it('GitHub Actions fills the JWKS, issuer, algorithm, Single use and a repository row', () => {
    const values = applyJwtPreset({ keyType: 'passphrase', secret: 'x', boundClaims: '' }, preset('github'));
    expect(values).toMatchObject({
      keyType: 'jwks',
      jwksUrl: 'https://token.actions.githubusercontent.com/.well-known/jwks',
      issuer: 'https://token.actions.githubusercontent.com',
      algorithm: 'RS256',
      singleUse: true,
    });
    expect(preset('github').claim).toBe('repository');
  });

  it('GitLab CI does the same with project_path', () => {
    const values = applyJwtPreset({}, preset('gitlab'));
    expect(values).toMatchObject({ keyType: 'jwks', jwksUrl: 'https://gitlab.com/oauth/discovery/keys', issuer: 'https://gitlab.com', algorithm: 'RS256', singleUse: true });
    expect(preset('gitlab').claim).toBe('project_path');
  });

  it('keeps bound claims already written', () => {
    expect(applyJwtPreset({ boundClaims: 'repository: my-org/app' }, preset('github')).boundClaims).toBe('repository: my-org/app');
  });
});

describe('the claims editor', () => {
  it('writes rows back as the same text the parser reads, leaving out unfinished rows', () => {
    const text = textFromClaimRows([
      { claim: 'repository', pattern: 'my-org/app' },
      { claim: 'ref', pattern: '' },
      { claim: 'sub', pattern: 'repo:my-org/app:ref:refs/heads/*' },
    ]);
    expect(text).toBe('repository: my-org/app\nsub: repo:my-org/app:ref:refs/heads/*');
    expect(parseBoundClaims(text).problems).toEqual([]);
    expect(claimRowsFromText(text)).toEqual([
      { claim: 'repository', pattern: 'my-org/app' },
      { claim: 'sub', pattern: 'repo:my-org/app:ref:refs/heads/*' },
    ]);
  });

  it('renders a row per claim, the presets, and the parser’s problem for a bad line', () => {
    const html = renderToStaticMarkup(createElement(JwtAuthPresets, { values: { boundClaims: 'repository: my-org/app\nref: refs/heads/main' }, onChange: () => undefined }));
    expect(html).toContain('GitHub Actions');
    expect(html).toContain('GitLab CI');
    expect(html).toContain('value="my-org/app"');
    expect(html).toContain('value="refs/heads/main"');
    expect(html).not.toContain('line 1');
    const bad = renderToStaticMarkup(createElement(JwtAuthPresets, { values: { boundClaims: 'nonsense' }, onChange: () => undefined }));
    expect(bad).toContain('line 1');
  });

  it('is meant for the jwtAuth type only', () => {
    expect(JWT_AUTH_CREDENTIAL).toBe('core.jwtAuth');
  });
});
