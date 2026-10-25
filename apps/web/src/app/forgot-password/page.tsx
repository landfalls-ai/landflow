import type { Metadata } from 'next';
import Link from 'next/link';
import { mailConfigured } from '@/lib/server/auth/mail';
import { AuthShell, ForgotForm } from '@/components/auth/auth-forms';

export const metadata: Metadata = { title: 'Reset password · Landflow' };
export const dynamic = 'force-dynamic';

/** /forgot-password: email yourself a reset link (or, without SMTP, how to get one from an admin). */
export default function ForgotPasswordPage() {
  const smtp = mailConfigured();
  return (
    <AuthShell
      title="Reset your password"
      subtitle={smtp ? 'Enter your email and we’ll send you a link to choose a new password.' : undefined}
      footer={
        <Link href="/login" className="text-t2 hover:text-ac">
          Back to sign in
        </Link>
      }
    >
      <ForgotForm smtp={smtp} />
    </AuthShell>
  );
}
