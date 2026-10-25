import type { Metadata } from 'next';
import Link from 'next/link';
import { AuthShell, ResetForm } from '@/components/auth/auth-forms';

export const metadata: Metadata = { title: 'Choose a new password · Landflow' };

/** /reset-password/<token>: choose a new password from a reset link (it signs you out everywhere else). */
export default async function ResetPasswordPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <AuthShell
      title="Choose a new password"
      footer={
        <Link href="/login" className="text-t2 hover:text-ac">
          Back to sign in
        </Link>
      }
    >
      <ResetForm token={token} />
    </AuthShell>
  );
}
