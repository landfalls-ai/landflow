/**
 * C16 / P15a: the second-factor screens, rendered to static HTML as the other UI tests do: the sign-in step, Sign-in &
 * security (a factor with "last used", recovery codes left, the enrolment with its QR code and setup key), the user
 * menu, Settings → Users and Settings → Security. No client module builds a zod schema (the CSP forbids `eval`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { isChromelessPage } from '../src/lib/shared/auth-paths';
import type { MfaStateView, SecurityView, UserView, Viewer } from '../src/lib/shared/auth';
import { canResetMfa } from '../src/lib/shared/auth';

const root = join(import.meta.dirname, '..', 'src');
const html = (node: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(node);

const state = (over: Partial<MfaStateView> = {}): MfaStateView => ({
  factors: [{ id: 'mfa_1', kind: 'totp', name: 'Authenticator app', confirmed: true, createdAt: '2026-11-20T10:00:00.000Z', lastUsedAt: new Date(Date.now() - 3 * 3_600_000).toISOString() }],
  recoveryCodesLeft: 9,
  mode: 'off',
  covered: false,
  enrolmentRequired: false,
  recentlyVerified: true,
  canEnrol: true,
  ...over,
});

describe('the sign-in second step', () => {
  it('asks for a one-time code and offers a recovery code instead', async () => {
    const { MfaStep } = await import('../src/components/auth/mfa-step');
    const out = html(createElement(MfaStep, { challenge: 'c', methods: ['totp', 'recovery'], next: '/', onBack: () => {} }));
    expect(out).toMatch(/autocomplete="one-time-code"/i);
    expect(out).toContain('Use a recovery code instead');
    expect(out).toMatch(/<form [^>]*method="post"/);
  });

  it('with only recovery codes left asks for one straight away', async () => {
    const { MfaStep } = await import('../src/components/auth/mfa-step');
    const out = html(createElement(MfaStep, { challenge: 'c', methods: ['recovery'], next: '/', onBack: () => {} }));
    expect(out).toContain('Recovery code');
    expect(out).not.toContain('Use a recovery code instead');
  });
});

describe('Sign-in & security', () => {
  it('lists the factor with when it was last used, and how many recovery codes are left', async () => {
    const { SignInSecurity } = await import('../src/components/account/sign-in-security');
    const out = html(createElement(SignInSecurity, { initial: state() }));
    expect(out).toContain('Authenticator app');
    expect(out).toMatch(/Last used \d+h ago|Last used 3 hours ago|Last used/);
    expect(out).toContain('9 recovery codes left');
    expect(out).toContain('Make new codes');
    expect(out).toContain('aria-label="Remove Authenticator app"');
  });

  it('offers to add an app when there is none, and says why a covered role keeps its last factor', async () => {
    const { SignInSecurity } = await import('../src/components/account/sign-in-security');
    expect(html(createElement(SignInSecurity, { initial: state({ factors: [], recoveryCodesLeft: 0 }) }))).toContain('Add authenticator app');
    expect(html(createElement(SignInSecurity, { initial: state({ covered: true, mode: 'admins' }) }))).toContain('not remove your last');
    expect(html(createElement(SignInSecurity, { initial: state({ factors: [], canEnrol: false }) }))).toContain('single sign-on');
  });

  it('shows the QR code as a data image and the setup key as text while enrolling', async () => {
    const { TotpEnrol } = await import('../src/components/account/totp-enrol');
    const out = html(createElement(TotpEnrol, { onConfirmed: () => {}, initial: { factorId: 'f', secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', otpauthUrl: 'otpauth://x', qr: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' } }));
    expect(out).toMatch(/<img [^>]*src="data:image\/svg\+xml;base64,/);
    expect(out).toContain('ABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
    expect(out).toMatch(/autocomplete="one-time-code"/i);
  });

  it('shows new recovery codes once with Copy and Download', async () => {
    const { RecoveryCodes } = await import('../src/components/account/recovery-codes');
    const out = html(createElement(RecoveryCodes, { codes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'], onDone: () => {} }));
    expect(out).toContain('AAAAA-BBBBB');
    expect(out).toContain('Download .txt');
    expect(out).toContain('Copy codes');
  });

  it('/login/second-factor renders without the sidebar, and the page has a Sign out link', () => {
    expect(isChromelessPage('/login/second-factor')).toBe(true);
    expect(isChromelessPage('/account/security')).toBe(false);
    expect(readFileSync(join(root, 'app/login/second-factor/page.tsx'), 'utf8')).toContain('SignOutLink');
  });
});

describe('around the app', () => {
  const viewer = (role: Viewer['role']): Viewer => ({ id: `usr_${role}`, name: role, email: `${role}@x.test`, role, sso: false, hasPassword: true });

  it('puts Sign-in & security in the user menu', async () => {
    const { UserMenu } = await import('../src/components/auth/user-menu');
    const { ViewerProvider } = await import('../src/components/auth/viewer');
    const out = html(createElement(ViewerProvider, { viewer: viewer('member'), children: createElement(UserMenu, { defaultOpen: true }) }));
    expect(out).toContain('href="/account/security"');
    expect(out).toContain('Sign-in &amp; security');
  });

  it('shows "2-step" and Reset second factor to an admin, and hides the reset on an owner', async () => {
    const { UsersSettings } = await import('../src/components/settings/users-settings');
    const { ViewerProvider } = await import('../src/components/auth/viewer');
    const user = (id: string, role: UserView['role'], mfaFactors?: number): UserView => ({ ...viewer(role), id, name: `Name ${id}`, createdAt: '2026-11-01T00:00:00.000Z', ...(mfaFactors && { mfaFactors }) });
    const users = [user('own', 'owner', 1), user('mem', 'member', 1), user('plain', 'member')];
    const out = html(createElement(ViewerProvider, { viewer: viewer('admin'), children: createElement(UsersSettings, { initial: users }) }));
    expect(out.match(/2-step/g)).toHaveLength(2);
    expect(out).toContain('aria-label="Reset second factor of Name mem"');
    expect(out).not.toContain('aria-label="Reset second factor of Name own"');
    expect(out).not.toContain('aria-label="Reset second factor of Name plain"');
    expect(canResetMfa(viewer('admin'), { id: 'x', role: 'owner' })).toBe(false);
  });

  it('shows the policy in Settings → Security with the variable name', async () => {
    const { SecuritySettings } = await import('../src/components/settings/security-settings');
    const view = { oidc: { configured: false, label: 'SSO', roleClaim: 'roles', roleMap: {}, defaultRole: 'member' }, smtp: { configured: false }, mfa: { mode: 'admins' }, sessionHours: 336, registrySecret: false, metricsPublic: false } as SecurityView;
    const out = html(createElement(SecuritySettings, { initial: view }));
    expect(out).toContain('Second factor required: admins');
    expect(out).toContain('LANDFLOW_MFA_REQUIRED');
  });

  it('builds no zod schema in the new client modules', () => {
    for (const file of ['components/auth/mfa-step.tsx', 'components/account/sign-in-security.tsx', 'components/account/totp-enrol.tsx', 'components/account/recovery-codes.tsx', 'components/auth/sign-out-link.tsx']) {
      expect(readFileSync(join(root, file), 'utf8')).not.toMatch(/from 'zod'|z\.object/);
    }
  });
});

describe('passkeys (P15b)', () => {
  it('the sign-in step leads with "Use my passkey" and offers the other methods', async () => {
    const { MfaStep } = await import('../src/components/auth/mfa-step');
    const out = html(createElement(MfaStep, { challenge: 'c', methods: ['webauthn', 'totp', 'recovery'], next: '/', onBack: () => {} }));
    expect(out).toContain('Use my passkey');
    expect(out).not.toMatch(/autocomplete="one-time-code"/i);
    expect(out).toContain('Use my authenticator app instead');
    expect(out).toContain('Use a recovery code instead');
    // Without a passkey the step is the code field it was.
    expect(html(createElement(MfaStep, { challenge: 'c', methods: ['totp', 'recovery'], next: '/', onBack: () => {} }))).not.toContain('Use a passkey instead');
  });

  it('Sign-in & security lists passkeys with their names and "flagged", and offers to add one', async () => {
    const { SignInSecurity } = await import('../src/components/account/sign-in-security');
    const out = html(
      createElement(SignInSecurity, {
        initial: state({
          factors: [
            { id: 'mfa_1', kind: 'webauthn', name: 'Work laptop', confirmed: true, createdAt: '2026-11-20T10:00:00.000Z' },
            { id: 'mfa_2', kind: 'webauthn', name: 'Old key', confirmed: true, createdAt: '2026-11-20T10:00:00.000Z', flagged: true },
          ],
        }),
      }),
    );
    expect(out).toContain('Work laptop');
    expect(out).toContain('Old key');
    expect(out).toContain('flagged');
    expect(out).toContain('aria-label="Remove Work laptop"');
    expect(out).toContain('Add a passkey');
    expect(out).toContain('Add authenticator app');
  });

  it('the first-factor page offers a passkey or an app', async () => {
    const { EnrolFlow } = await import('../src/components/account/sign-in-security');
    const out = html(createElement(EnrolFlow, { next: '/' }));
    expect(out).toContain('Passkey');
    expect(out).toContain('Authenticator app');
    expect(out).toContain('Name this passkey');
  });

  it('hides Add a passkey at ten with a hint, and tells a person with no way through to ask an admin', async () => {
    const { SignInSecurity } = await import('../src/components/account/sign-in-security');
    const ten = Array.from({ length: 10 }, (_, i) => ({ id: `mfa_${i}`, kind: 'webauthn' as const, name: `Key ${i}`, confirmed: true, createdAt: '2026-11-20T10:00:00.000Z' }));
    const out = html(createElement(SignInSecurity, { initial: state({ factors: ten }) }));
    expect(out).not.toContain('Add a passkey');
    expect(out).toContain('up to 10 passkeys');
    const { MfaStep } = await import('../src/components/auth/mfa-step');
    const none = html(createElement(MfaStep, { challenge: 'c', methods: [], next: '/', onBack: () => {} }));
    expect(none).toContain('ask an owner or admin to reset');
    expect(none).not.toContain('Sign in <');
  });
});
