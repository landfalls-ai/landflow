/**
 * The sign-in pages' forms. Every form posts: submitted before the page hydrates, a form without a method is a GET that
 * puts the email and password in the URL (history, proxy and access logs); the invite and reset forms render only after a
 * fetch, so that check reads the source. The login form is rendered to static HTML for each LANDFLOW_LOCAL_SIGN_IN mode,
 * with and without single sign-on.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoginForm } from '../src/components/auth/auth-forms';

type LoginProps = Parameters<typeof LoginForm>[0];
const login = (props: Partial<LoginProps>) => renderToStaticMarkup(createElement(LoginForm, { next: '/', smtp: true, ...props }));
const OFF_NOTICE = 'Signing in with a password is turned off here';

describe('auth forms', () => {
  it('every form posts, so an early submit never puts credentials in the URL', () => {
    const source = readFileSync(join(import.meta.dirname, '..', 'src', 'components', 'auth', 'auth-forms.tsx'), 'utf8');
    const forms = [...source.matchAll(/<form\b[^>]*?(?:>|onSubmit)/gs)].map((m) => m[0]);
    expect(forms).toHaveLength(5);
    for (const form of forms) expect(form).toMatch(/method="post"/);
    expect(login({})).toMatch(/<form [^>]*method="post"/);
  });

  it('shows the password form, and the SSO buttons with an or-divider, when local sign-in is allowed', () => {
    for (const localSignIn of ['all', 'owner'] as const) {
      const plain = login({ localSignIn });
      expect(plain).toContain('type="password"');
      expect(plain).toContain('Sign in');
      expect(plain).not.toContain(OFF_NOTICE);
      const withSso = login({ localSignIn, oidcLabel: 'Sign in with Keycloak', samlLabel: 'Sign in with Okta' });
      expect(withSso).toContain('/api/auth/oidc/login?next=%2F');
      expect(withSso).toContain('/api/auth/saml/login?next=%2F');
      expect(withSso).toMatch(/<span[^>]*><\/span> or <span/);
      expect(withSso).toContain('type="password"');
    }
  });

  it('under localSignIn=off shows only the SSO buttons, with no password field or divider', () => {
    const html = login({ localSignIn: 'off', oidcLabel: 'Sign in with Keycloak', initialError: 'The identity provider said no' });
    expect(html).toContain('Sign in with Keycloak');
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain('type="email"');
    expect(html).not.toMatch(/<\/span> or <span/);
    expect(html).not.toContain(OFF_NOTICE);
    expect(html).toContain('The identity provider said no');
  });

  it('under localSignIn=off with no SSO says why, with no form fields', () => {
    const html = login({ localSignIn: 'off' });
    expect(html).toContain(OFF_NOTICE);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Forgot your password?');
  });
});
