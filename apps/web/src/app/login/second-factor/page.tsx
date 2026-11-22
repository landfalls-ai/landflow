import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { safeNext } from '@/lib/shared/auth-paths';
import { currentPageUser } from '@/lib/server/auth/pages';
import { enrolmentRequired } from '@/lib/server/auth/mfa';
import { AuthShell } from '@/components/auth/auth-forms';
import { EnrolFlow } from '@/components/account/sign-in-security';
import { SignOutLink } from '@/components/auth/sign-out-link';

export const metadata: Metadata = { title: 'Add a second factor · Landflow' };

/**
 * /login/second-factor?enrol=1&next=: where a signed-in account that the policy (LANDFLOW_MFA_REQUIRED) covers adds its
 * first factor; every other page sends it here until it has. Chromeless, like the other sign-in pages.
 */
export default async function SecondFactorPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const next = safeNext((await searchParams).next);
  const user = await currentPageUser();
  if (!user) redirect('/login');
  // Not just "has a factor": a flagged passkey is no factor, and the policy still asks this person to add one.
  if (!enrolmentRequired(user, 'password')) redirect(next);
  return (
    <AuthShell title="Add a second factor" subtitle="This instance asks for a second factor on your account. Add one to go on." footer={<SignOutLink />}>
      <EnrolFlow next={next} />
    </AuthShell>
  );
}
