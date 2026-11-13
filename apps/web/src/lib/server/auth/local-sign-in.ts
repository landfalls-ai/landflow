import { envString } from '@/lib/server/config';

/**
 * LANDFLOW_LOCAL_SIGN_IN: who may sign in with a password. `all` (default); `owner` (only the owner: the break-glass
 * account when SSO breaks); `off` (SSO only, OIDC or SAML, which carry the identity provider's MFA). Landflow has no
 * second factor of its own yet, so this is how an instance gets one.
 */
export type LocalSignIn = 'all' | 'owner' | 'off';

/** May this user sign in (or be signed in by a reset link) with a password under the current mode? */
export function localSignInAllowed(user: { role: string }): boolean {
  const mode = localSignInMode();
  return !(mode === 'off' || (mode === 'owner' && user.role !== 'owner'));
}

export function localSignInMode(): LocalSignIn {
  const value = envString('LANDFLOW_LOCAL_SIGN_IN')?.toLowerCase();
  return value === 'owner' || value === 'off' ? value : 'all';
}
