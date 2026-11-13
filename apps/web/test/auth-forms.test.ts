/**
 * The sign-in pages' forms post: submitted before the page hydrates, a form without a method is a GET that puts the
 * email and password in the URL (history, proxy and access logs). The tests don't render TSX, so this reads the source.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('auth forms', () => {
  it('every form posts, so an early submit never puts credentials in the URL', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'auth', 'auth-forms.tsx'), 'utf8');
    const forms = [...source.matchAll(/<form\b[^>]*?(?:>|onSubmit)/gs)].map((m) => m[0]);
    expect(forms).toHaveLength(5);
    for (const form of forms) expect(form).toMatch(/method="post"/);
  });

  it('the login form drops the password fields under localSignIn=off and says why when no SSO is set up', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'auth', 'auth-forms.tsx'), 'utf8');
    expect(source).toContain("const ssoOnly = localSignIn === 'off'");
    expect(source).toContain('{!ssoOnly && (');
    expect(source).toContain('{ssoOnly ? (');
    expect(source).toContain('Signing in with a password is turned off here');
  });
});
