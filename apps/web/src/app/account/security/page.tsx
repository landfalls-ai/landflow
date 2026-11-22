import type { Metadata } from 'next';
import { SignInSecurity } from '@/components/account/sign-in-security';
import { PageBody, PageHeader } from '@/components/shell/page-header';

export const metadata: Metadata = { title: 'Sign-in & security · Landflow' };

/** /account/security: your second factors and recovery codes (docs/features/authentication.md#second-factor). */
export default function SecurityPage() {
  return (
    <>
      <PageHeader title="Sign-in & security" meta={<span>Your second factor and recovery codes</span>} />
      <PageBody width="narrow">
        <SignInSecurity />
      </PageBody>
    </>
  );
}
