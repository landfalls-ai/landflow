'use client';
/**
 * The page a sign-in link opens (`/request-access#t=<token>`): it waits for "Continue" so a mail scanner that opens the link burns
 * nothing. The token never leaves the browser until the button is pressed, and the address bar drops it after.
 */
import { LogIn } from 'lucide-react';
import { Card } from '../../shell/page-header';
import { Button } from '../../ui/button';

/** `email` is the masked address of the link (`m•••@partner.test`), so a link opened on the wrong device is noticed before it is used. */
export function VerifyCard({ busy, error, email, onContinue }: { busy?: boolean; error?: string; email?: string; onContinue: () => void }) {
  return (
    <Card className="mx-auto flex max-w-[460px] flex-col gap-3">
      <LogIn className="size-6 text-ac" aria-hidden />
      <h2 data-testid="outside-verify" className="text-[17px] font-semibold text-t1">Confirm that you want to sign in</h2>
      <p className="text-[13.5px] leading-relaxed text-t2">{email ? <>This link is for <strong data-testid="outside-verify-email">{email}</strong>. Press Continue to sign in on this device; the link works once.</> : 'Press Continue to sign in on this device. The link works once.'}</p>
      {error && <p role="alert" className="text-[13px] text-rd">{error}</p>}
      <Button variant="primary" loading={busy} disabled={busy} onClick={onContinue} data-testid="outside-continue" className="max-md:h-11 max-md:w-full">{email ? `Continue as ${email}` : 'Continue'}</Button>
    </Card>
  );
}
