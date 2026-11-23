'use client';
/**
 * Sign in (docs/access-requests.md#the-request-page): the work email field ("Email me a link": one link, once, 15 minutes) and,
 * when an admin switched it on, "Sign in with Google". The answer never says whether an address may ask: after sending it is always
 * "Check your email".
 */
import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { MailCheck, TriangleAlert } from 'lucide-react';
import { OUTSIDE_BASE } from '@/lib/client/access-outside';
import { Card } from '../../shell/page-header';
import { Button } from '../../ui/button';
import { FieldLabel, Input } from '../../ui/inputs';

export function SignInCard({ google, mail, notice, noticeLink, sent, busy, error, onSubmit, onAnother }: { google: boolean; mail: boolean; notice?: string; noticeLink?: string; sent?: string; busy?: boolean; error?: string; onSubmit: (email: string) => void; onAnother?: () => void }) {
  const [email, setEmail] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (email.trim() && !busy) onSubmit(email.trim());
  };
  if (sent) {
    return (
      <Card className="mx-auto flex max-w-[460px] flex-col gap-3">
        <MailCheck className="size-6 text-ac" aria-hidden />
        <h2 data-testid="outside-sent" className="text-[17px] font-semibold text-t1">Check your email</h2>
        <p className="text-[13.5px] leading-relaxed text-t2">
          If <span className="font-semibold text-t1 [overflow-wrap:anywhere]">{sent}</span> may ask here, a sign-in link is on its way. It works once, for 15 minutes. You can open it on any device.
        </p>
        {onAnother && <div><Button variant="outline" onClick={onAnother} className="max-md:h-11 max-md:w-full">Use another address</Button></div>}
      </Card>
    );
  }
  return (
    <Card className="mx-auto flex max-w-[460px] flex-col gap-4">
      <div>
        <h2 className="text-[17px] font-semibold text-t1">Ask for access</h2>
        <p className="mt-1 text-[13.5px] leading-relaxed text-t2">Sign in with your work email to ask for a team, a group or a seat. Someone at the company decides, and you get an email when they have.</p>
      </div>
      {notice && (
        <p role="alert" data-testid="outside-notice" className="flex gap-2 rounded-xl border border-rdbd bg-rddim px-3 py-2 text-[13px] text-rd">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {notice}
            {noticeLink && <> <Link href={noticeLink} className="font-semibold underline">Open Access</Link></>}
          </span>
        </p>
      )}
      {mail && (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <div>
            <FieldLabel>Work email</FieldLabel>
            <Input type="email" name="email" autoComplete="email" inputMode="email" autoCapitalize="none" autoCorrect="off" aria-label="Your work email" data-testid="outside-email-input" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className="max-md:h-11" />
          </div>
          {error && <p role="alert" className="text-[13px] text-rd">{error}</p>}
          <Button type="submit" variant="primary" loading={busy} disabled={!email.trim()} data-testid="outside-send" className="max-md:h-11 max-md:w-full">Email me a link</Button>
        </form>
      )}
      {mail && google && <p aria-hidden className="text-center text-[12px] text-t3">or</p>}
      {google && (
        // A plain link: the server answers with a redirect to Google (state, nonce and PKCE are its job).
        <a href={`${OUTSIDE_BASE}/sign-in/google`} data-testid="outside-google" className="inline-flex h-9 items-center justify-center rounded-full border border-hair bg-sf px-4 text-[13px] font-semibold text-t1 transition-colors hover:border-ac max-md:h-11">
          Sign in with Google
        </a>
      )}
      {!mail && !google && <p className="text-[13.5px] text-t2">Asking by email isn't available here. Ask the person who sent you the link.</p>}
    </Card>
  );
}
