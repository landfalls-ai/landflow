'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Activity, BookOpenCheck, BookOpenText, Bot, ChartColumn, House, KeyRound, LayoutTemplate, Menu, Puzzle, Search, Settings, Store, Table2, Workflow, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { useLiveConnected, useLiveEvents } from '@/lib/client/live';
import { isChromelessPage } from '@/lib/shared/auth-paths';
import type { PluginSummary } from '@/lib/shared/types';
import { UserMenu } from '../auth/user-menu';
import { useViewer } from '../auth/viewer';
import { ProjectSwitcher } from '../projects/project-switcher';
import { StatusDot } from '../ui/badge';
import { EnvironmentBadge } from './environment-badge';
import { LookToggle } from './look-toggle';
import { ThemeToggle } from './theme-toggle';

const GROUPS: Array<{ label: string; items: Array<{ href: string; label: string; icon: typeof House; preview?: boolean }> }> = [
  {
    label: 'Build',
    items: [
      { href: '/', label: 'Home', icon: House },
      { href: '/workflows', label: 'Workflows', icon: Workflow },
      { href: '/templates', label: 'Templates', icon: LayoutTemplate },
      { href: '/agents', label: 'Agents', icon: Bot, preview: true },
      { href: '/executions', label: 'Executions', icon: Activity },
      { href: '/runs', label: 'Search runs', icon: Search },
      { href: '/insights', label: 'Insights', icon: ChartColumn },
      { href: '/data-tables', label: 'Data tables', icon: Table2 },
      { href: '/runbooks', label: 'Runbooks', icon: BookOpenCheck },
      { href: '/credentials', label: 'Credentials', icon: KeyRound },
    ],
  },
  {
    label: 'Extend',
    items: [
      { href: '/plugins', label: 'Plugins', icon: Puzzle },
      { href: '/marketplace', label: 'Marketplace', icon: Store },
      { href: '/developers', label: 'Build a plugin', icon: BookOpenText },
    ],
  },
];

/**
 * The left rail: product mark, grouped navigation, live status, the user menu. Not on sign-in and public pages. On a phone
 * (below `md`) the rail is a drawer behind a slim top bar with a menu button.
 */
export function Sidebar() {
  const pathname = usePathname();
  const viewer = useViewer();
  // The phone drawer: open from the top bar, closed when a link is followed.
  const [openOn, setOpenOn] = useState<string>();
  if (!viewer || isChromelessPage(pathname)) return null;
  const open = openOn === pathname;
  return (
    <>
      <PhoneBar onMenu={() => setOpenOn(pathname)} />
      {open && <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={() => setOpenOn(undefined)} aria-hidden />}
      <Rail pathname={pathname} open={open} onClose={() => setOpenOn(undefined)} />
    </>
  );
}

function PhoneBar({ onMenu }: { onMenu: () => void }) {
  const connected = useLiveConnected();
  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-hair bg-sf2 px-2 md:hidden">
      <button type="button" aria-label="Open the menu" onClick={onMenu} className="grid size-9 place-items-center rounded-lg text-t2 hover:bg-acdim hover:text-t1">
        <Menu className="size-[18px]" strokeWidth={1.7} />
      </button>
      <Link href="/" className="flex items-center gap-2">
        <span className="grid size-7 place-items-center rounded-[8px] border border-acbd bg-ac2 text-[11px] font-bold text-on-ac">LF</span>
        <span className="text-[13px] font-semibold text-t1">Landflow</span>
      </Link>
      <span className="ml-auto pr-1" title={connected ? 'Receiving live events' : 'Reconnecting to the event stream'}>
        <StatusDot status={connected ? 'online' : 'offline'} />
      </span>
    </div>
  );
}

function Rail({ pathname, open, onClose }: { pathname: string; open: boolean; onClose: () => void }) {
  const connected = useLiveConnected();
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);

  const load = () => api<{ plugins: PluginSummary[] }>('/api/plugins').then((r) => setPlugins(r.plugins)).catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  useLiveEvents((event) => {
    if (event.channel === 'registry' && event.event.type !== 'plugin.heartbeat' && !event.event.type.startsWith('scan.')) void load();
  });
  const online = plugins.filter((p) => p.status === 'online').length;

  return (
    <aside
      className={cn(
        'top-0 h-screen w-[196px] shrink-0 flex-col border-r border-hair bg-sf2 px-1.5 py-2.5 md:sticky md:z-30 md:flex md:shadow-none',
        open ? 'fixed left-0 z-50 flex overflow-y-auto shadow-pop' : 'hidden',
      )}
    >
      <button type="button" aria-label="Close the menu" onClick={onClose} className="absolute right-1.5 top-2.5 grid size-8 place-items-center rounded-lg text-t3 hover:bg-acdim hover:text-t1 md:hidden">
        <X className="size-4" />
      </button>
      <Link href="/" className="mb-2 flex items-center gap-2.5 px-2.5 py-1">
        <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] border border-acbd bg-ac2 text-[12px] font-bold tracking-[0.02em] text-on-ac">LF</span>
        <span className="truncate text-[13px] font-semibold text-t1">Landflow</span>
      </Link>
      <EnvironmentBadge />
      <ProjectSwitcher />

      <nav className="flex flex-col">
        {GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className="px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">{group.label}</div>
            {group.items.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={cn('flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors duration-[120ms]', active ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1')}
                >
                  <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
                  <span className="truncate">{item.label}</span>
                  {item.preview && <span className="ml-auto rounded-full border border-acbd bg-acdim px-1.5 text-[10px] font-semibold leading-4 text-ac">Preview</span>}
                  {item.href === '/plugins' && plugins.length > 0 && <span className="ml-auto font-mono text-[11px] font-normal text-t3">{online}/{plugins.length}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <Link
        href="/settings"
        aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
        className={cn(
          'mb-2 mt-auto flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors duration-[120ms]',
          pathname.startsWith('/settings') ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1',
        )}
      >
        <Settings className="size-[18px] shrink-0" strokeWidth={1.7} />
        <span className="truncate">Settings</span>
      </Link>
      <div className="flex flex-col gap-2.5 px-2.5 pb-1">
        <div className="flex items-center gap-2 text-[12px] text-t3" title={connected ? 'Receiving live events' : 'Reconnecting to the event stream'}>
          <StatusDot status={connected ? 'online' : 'offline'} />
          {connected ? 'Live' : 'Reconnecting…'}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <ThemeToggle />
          <LookToggle />
        </div>
      </div>
      <div className="mt-2 border-t border-hair pt-2">
        <UserMenu />
      </div>
    </aside>
  );
}
