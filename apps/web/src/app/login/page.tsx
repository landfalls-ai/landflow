import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { safeNext } from '@/lib/shared/auth-paths';
import { setupRequired } from '@/lib/server/auth';
import { mailConfigured } from '@/lib/server/auth/mail';
import { localSignInMode } from '@/lib/server/auth/local-sign-in';
import { oidcConfig } from '@/lib/server/auth/oidc';
import { samlConfig } from '@/lib/server/auth/saml';
import { currentPageUser } from '@/lib/server/auth/pages';
import { AuthShell, LoginForm } from '@/components/auth/auth-forms';

export const metadata: Metadata = { title: 'Sign in · Landflow' };

/** /login?next=&error=: sign in with a password, or SSO when configured. A fresh instance goes to /setup first. */
export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  if (await currentPageUser()) redirect(next);
  if (setupRequired()) redirect('/setup');
  const oidc = oidcConfig();
  const saml = samlConfig();
  const mode = localSignInMode();
  // SSO-only with no provider: nobody can sign in here, so no welcome above the notice.
  const noWay = mode === 'off' && !oidc && !saml;
  return (
    <AuthShell title="Sign in" subtitle={noWay ? undefined : 'Welcome back. Sign in to build and run workflows.'}>
      <LoginForm next={next} oidcLabel={oidc?.label} samlLabel={saml?.label} initialError={params.error?.slice(0, 300)} smtp={mailConfigured()} localSignIn={mode} />
    </AuthShell>
  );
}
