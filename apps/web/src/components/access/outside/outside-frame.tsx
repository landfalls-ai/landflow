'use client';
/**
 * The public request page's frame (docs/access-requests.md#the-request-page): the Landflow mark, a narrow centred column, and when
 * someone is signed in their address with Sign out. It has no sidebar, no Spotlight and no Landflow data: a person without an
 * account sees only this.
 */
import type { ReactNode } from 'react';
import { Button } from '../../ui/button';

export function OutsideFrame({ children, email, onSignOut }: { children: ReactNode; email?: string; onSignOut?: () => void }) {
  return (
    <div className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-20 border-b border-hair bg-bg">
        <div className="mx-auto flex min-h-[52px] w-full max-w-[860px] items-center gap-3 px-4 py-1.5 md:px-6">
          <span aria-hidden className="grid size-[30px] shrink-0 place-items-center rounded-[9px] border border-acbd bg-ac2 text-[11px] font-bold tracking-[0.02em] text-on-ac">LF</span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-tight text-t1">Landflow</p>
            <p className="text-[12px] leading-tight text-t3">Ask for access</p>
          </div>
          {email && (
            <div className="flex min-w-0 items-center gap-2">
              <span data-testid="outside-email" className="hidden min-w-0 truncate text-[12.5px] text-t2 sm:block">{email}</span>
              {onSignOut && <Button size="sm" variant="outline" onClick={onSignOut} data-testid="outside-sign-out" className="max-md:h-11">Sign out</Button>}
            </div>
          )}
        </div>
        {email && <p className="mx-auto w-full max-w-[860px] truncate px-4 pb-1.5 text-[12px] text-t2 sm:hidden">Signed in as {email}</p>}
      </header>
      <main id="outside-main" className="mx-auto w-full max-w-[860px] px-4 py-5 md:px-6 md:py-8">{children}</main>
    </div>
  );
}
