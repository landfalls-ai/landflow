import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell, InviteForm } from '@/components/auth/auth-forms';

export const metadata: Metadata = { title: 'Accept invite · Landflow' };

/** /invite/<token>: accept an invite by choosing a name and a password. */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthShell
      title="Join Landflow"
      subtitle="Choose your name and a password to finish creating your account."
      footer={
        <>
          Have an account already?{' '}
          <Link href="/login" className="text-t2 hover:text-ac">
            Sign in
          </Link>
        </>
      }
    >
      <InviteForm token={token} />
    </AuthShell>
  );
}
