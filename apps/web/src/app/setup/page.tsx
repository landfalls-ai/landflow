import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { setupRequired } from '@/lib/server/auth';
import { currentPageUser } from '@/lib/server/auth/pages';
import { AuthShell, SetupForm } from '@/components/auth/auth-forms';

export const metadata: Metadata = { title: 'Set up · Landflow' };

/** /setup: the first visit to a fresh instance creates the owner. Once anyone exists it's the sign-in page. */
export default async function SetupPage() {
  if (await currentPageUser()) redirect('/');
  if (!setupRequired()) redirect('/login');
  return (
    <AuthShell
      title="Set up Landflow"
      subtitle="Create the owner account. The owner manages users, settings and credentials, and can invite admins and members."
      footer="For Docker and CI, LANDFLOW_OWNER_EMAIL and LANDFLOW_OWNER_PASSWORD create the owner at boot instead."
    >
      <SetupForm />
    </AuthShell>
  );
}
