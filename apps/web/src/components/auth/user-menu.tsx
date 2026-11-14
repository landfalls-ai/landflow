'use client';
/** The user menu at the bottom of the sidebar: who is signed in (name, email, role), the theme, Build a plugin, API keys, Users and sign out. */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { BookOpenText, ChevronsUpDown, KeyRound, LogOut, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { can, ROLE_LABELS } from '@/lib/shared/auth';
import { ThemeChoice } from '../shell/theme-toggle';
import { initials, signOut, useViewer } from './viewer';

/** `defaultOpen` lets a test render the open menu on the server. */
export function UserMenu({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const viewer = useViewer();
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!viewer) return null;
  const item = 'flex h-8 max-md:h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-t2 transition-colors duration-[120ms] hover:bg-acdim hover:text-t1';

  return (
    <div ref={root} className="relative">
      {open && (
        <div role="menu" className="absolute inset-x-0 bottom-full z-40 mb-1.5 animate-fade-up rounded-xl border border-hair bg-sf p-1 shadow-pop">
          <div className="px-2.5 pb-2 pt-1.5">
            <div className="truncate text-[13px] font-semibold text-t1">{viewer.name}</div>
            <div className="truncate text-[12px] text-t3">{viewer.email}</div>
            <div className="mt-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
              {ROLE_LABELS[viewer.role]}
              {viewer.sso && ' · SSO'}
            </div>
          </div>
          <div className="my-0.5 border-t border-hair" />
          <ThemeChoice />
          <div className="my-0.5 border-t border-hair" />
          <Link role="menuitem" href="/developers" onClick={() => setOpen(false)} className={item}>
            <BookOpenText className="size-4 shrink-0" strokeWidth={1.7} /> Build a plugin
          </Link>
          <Link role="menuitem" href="/settings#api-keys" onClick={() => setOpen(false)} className={item}>
            <KeyRound className="size-4 shrink-0" strokeWidth={1.7} /> API keys
          </Link>
          {can(viewer, 'users:manage') && (
            <Link role="menuitem" href="/settings#users" onClick={() => setOpen(false)} className={item}>
              <Users className="size-4 shrink-0" strokeWidth={1.7} /> Users
            </Link>
          )}
          <button role="menuitem" onClick={() => void signOut()} className={item}>
            <LogOut className="size-4 shrink-0" strokeWidth={1.7} /> Sign out
          </button>
        </div>
      )}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`${viewer.name} (${viewer.email})`}
        className={cn('flex h-10 w-full items-center gap-2.5 rounded-lg px-1.5 text-left transition-colors duration-[120ms] hover:bg-acdim', open && 'bg-acdim')}
      >
        <span className="grid size-7 shrink-0 place-items-center rounded-full border border-acbd bg-acdim text-[11px] font-bold text-ac">{initials(viewer.name)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-semibold text-t1">{viewer.name}</span>
          <span className="block truncate text-[11px] text-t3">{viewer.email}</span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-t3" />
      </button>
    </div>
  );
}
