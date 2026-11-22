/**
 * C18 W4a: the JWT Auth credential dialog's helpers (components/credentials/jwt-auth-presets.tsx): the GitHub Actions and
 * GitLab CI presets, and the claims editor that reads and writes the credential's `boundClaims` text.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { applyJwtPreset, JWT_AUTH_CREDENTIAL, JWT_PRESETS, JwtAuthPresets, claimRowsFromText, spliceClaimRows } from '@/components/credentials/jwt-auth-presets';
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
      audience: 'landflow',
    });
    expect(preset('github').hint).toContain('core.getIDToken');
    expect(preset('github').claim).toBe('repository');
  });

  it('GitLab CI does the same with project_path', () => {
    const values = applyJwtPreset({}, preset('gitlab'));
    expect(values).toMatchObject({ keyType: 'jwks', jwksUrl: 'https://gitlab.com/oauth/discovery/keys', issuer: 'https://gitlab.com', algorithm: 'RS256', singleUse: true });
    expect(preset('gitlab').hint).toContain('id_tokens');
    expect(preset('gitlab').claim).toBe('project_path');
  });

  it('keeps an audience already written', () => {
    expect(applyJwtPreset({ audience: 'mine' }, preset('github')).audience).toBe('mine');
  });

  it('keeps bound claims already written', () => {
    expect(applyJwtPreset({ boundClaims: 'repository: my-org/app' }, preset('github')).boundClaims).toBe('repository: my-org/app');
  });
});

describe('the claims editor', () => {
  it('splices edits into the original text, keeping comments, unreadable lines and unfinished rows', () => {
    const text = '# who may call\nrepository: my-org/app\nnonsense\nref: refs/heads/main';
    const rows = claimRowsFromText(text);
    expect(rows.map((r) => [r.claim, r.line])).toEqual([['repository', 1], ['ref', 3]]);
    // An edit changes its own line only.
    const edited = spliceClaimRows(text, rows.map((r) => (r.claim === 'repository' ? { ...r, pattern: 'my-org/other' } : r)));
    expect(edited.text).toBe('# who may call\nrepository: my-org/other\nnonsense\nref: refs/heads/main');
    // A row removed takes its line with it; the comment and the bad line stay, and later rows keep their place.
    const removed = spliceClaimRows(text, [rows[1]]);
    expect(removed.text).toBe('# who may call\nnonsense\nref: refs/heads/main');
    expect(removed.rows[0].line).toBe(2);
    // A row emptied mid-edit leaves its line as it was; a new finished row is appended; an unfinished one is not written.
    const mid = spliceClaimRows(text, [{ ...rows[0], pattern: '' }, rows[1], { claim: 'environment', pattern: 'prod' }, { claim: 'x', pattern: '' }]);
    expect(mid.text).toBe(`${text}\nenvironment: prod`);
    expect(parseBoundClaims(mid.text).claims).toHaveLength(3);
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
