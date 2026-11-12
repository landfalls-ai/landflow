'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Activity, BookOpenCheck, BookOpenText, Bot, Brain, ChartColumn, Ellipsis, House, KeyRound, LayoutTemplate, PanelLeftClose, PanelLeftOpen, Puzzle, Search, Settings, Store, Table2, Workflow, X } from 'lucide-react';
import { useNeedsYou } from '@/lib/client/run-trace';
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
import { useDialogFocus } from '../ui/use-dialog-focus';

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
      { href: '/brain', label: 'Brain', icon: Brain },
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

const RAIL_KEY = 'landflow-rail-collapsed';

/**
 * The left rail: product mark, grouped navigation, live status, the user menu. Not on sign-in and public pages. On a desktop
 * it folds to its icons (the button beside the mark), so the editor's canvas and Spotlight get the room; the choice is kept
 * in the browser. On a phone (below `md`) a tab bar at the bottom takes its place (Home, Flows, Runs, Agents, More), and
 * More opens the rail as a drawer with everything else. Full-screen pages (the editor, a run's trace) have neither: their
 * own header has a back arrow.
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
      {!fullScreen(pathname) && <TabBar pathname={pathname} more={open} onMore={() => setOpenOn(open ? undefined : pathname)} />}
      {open && <div className="fixed inset-0 z-40 bg-black/30 md:hidden" onClick={() => setOpenOn(undefined)} aria-hidden />}
      <Rail pathname={pathname} open={open} onClose={() => setOpenOn(undefined)} />
    </>
  );
}

/** Pages that take the whole phone screen, with a back arrow of their own: the editor and its tabs, an agent, a run's trace. */
export const fullScreen = (pathname: string) => /^\/(workflows|agents)\/[^/]+/.test(pathname) || (/^\/runs\/[^/]+/.test(pathname) && pathname !== '/runs/compare');

const TABS = [
  { href: '/', label: 'Home', icon: House, match: (p: string) => p === '/' },
  { href: '/workflows', label: 'Flows', icon: Workflow, match: (p: string) => p.startsWith('/workflows') || p.startsWith('/templates') },
  { href: '/executions', label: 'Runs', icon: Activity, match: (p: string) => p.startsWith('/executions') || p.startsWith('/runs') },
  { href: '/agents', label: 'Agents', icon: Bot, match: (p: string) => p.startsWith('/agents') },
];

/** The phone's tab bar: four places and More (the rest, in the rail's drawer). Runs counts what waits for a person. */
function TabBar({ pathname, more, onMore }: { pathname: string; more: boolean; onMore: () => void }) {
  const { items } = useNeedsYou();
  const waiting = items?.length ?? 0;
  const inTabs = TABS.some((t) => t.match(pathname));
  return (
    <nav data-tabbar aria-label="Main" className="fixed inset-x-0 bottom-0 z-40 flex border-t border-hair bg-sf2/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      {TABS.map(({ href, label, icon: Icon, match }) => {
        const active = !more && match(pathname);
        return (
          <Link key={href} href={href} aria-current={active ? 'page' : undefined} className={cn('relative flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]', active ? 'font-semibold text-t1' : 'text-t3')}>
            <Icon className={cn('size-[22px]', active && 'text-ac')} strokeWidth={active ? 2 : 1.7} />
            {label}
            {href === '/executions' && waiting > 0 && (
              <>
                <span aria-hidden className="absolute left-1/2 top-1.5 ml-2 min-w-[18px] rounded-full bg-warn px-1 text-center text-[10.5px] font-semibold leading-[18px] text-bg">
                  {waiting > 99 ? '99+' : waiting}
                </span>
                <span className="sr-only">, {waiting} waiting for you</span>
              </>
            )}
          </Link>
        );
      })}
      <button type="button" onClick={onMore} aria-expanded={more} aria-label="More" className={cn('flex h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px]', more || !inTabs ? 'font-semibold text-t1' : 'text-t3')}>
        <Ellipsis className={cn('size-[22px]', (more || !inTabs) && 'text-ac')} strokeWidth={more || !inTabs ? 2 : 1.7} />
        More
      </button>
    </nav>
  );
}

/** The desktop rail folded to its icons: read after mount, so the server's HTML (unfolded) matches the first render. */
function useRailCollapsed(): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(RAIL_KEY) === 'yes');
    } catch {
      // Private mode: unfolded.
    }
  }, []);
  const set = (value: boolean) => {
    setCollapsed(value);
    try {
      localStorage.setItem(RAIL_KEY, value ? 'yes' : 'no');
    } catch {
      // Private mode: the choice holds for this page.
    }
  };
  return [collapsed, set];
}

function Rail({ pathname, open, onClose }: { pathname: string; open: boolean; onClose: () => void }) {
  const connected = useLiveConnected();
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [railCollapsed, setRailCollapsed] = useRailCollapsed();
  // Folded on a desktop only: the phone drawer always shows the labels.
  const folded = railCollapsed && !open;
  const label = folded ? 'md:hidden' : '';
  // The phone drawer is a dialog: focus goes in and stays, Escape closes it (docs/mobile.md#the-shell).
  const drawer = useRef<HTMLElement>(null);
  useDialogFocus(drawer, open, { onEscape: onClose });

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
      ref={drawer}
      role={open ? 'dialog' : undefined}
      aria-modal={open || undefined}
      aria-label={open ? 'Menu' : undefined}
      className={cn(
        'top-0 h-screen max-md:h-dvh w-[196px] shrink-0 flex-col border-r border-hair bg-sf2 px-1.5 py-2.5 transition-[width] duration-150 md:sticky md:z-30 md:flex md:shadow-none',
        folded && 'md:w-[56px]',
        open ? 'fixed left-0 z-50 flex overflow-y-auto shadow-pop' : 'hidden',
      )}
    >
      <button type="button" aria-label="Close the menu" onClick={onClose} className="absolute right-1.5 top-1.5 grid size-11 place-items-center rounded-lg text-t3 hover:bg-acdim hover:text-t1 md:hidden">
        <X className="size-4" />
      </button>
      <div className={cn('mb-2 flex items-center gap-1', folded && 'md:flex-col')}>
        <Link href="/" title="Landflow" className={cn('flex min-w-0 flex-1 items-center gap-2.5 px-2.5 py-1', folded && 'md:px-0.5')}>
          <span className="grid size-[34px] shrink-0 place-items-center rounded-[9px] border border-acbd bg-ac2 text-[12px] font-bold tracking-[0.02em] text-on-ac">LF</span>
          <span className={cn('truncate text-[13px] font-semibold text-t1', label)}>Landflow</span>
        </Link>
        <button
          type="button"
          onClick={() => setRailCollapsed(!railCollapsed)}
          aria-label={folded ? 'Show the menu' : 'Hide the menu'}
          aria-expanded={!folded}
          title={folded ? 'Show the menu' : 'Hide the menu'}
          className="hidden size-8 shrink-0 place-items-center rounded-lg text-t3 hover:bg-acdim hover:text-t1 md:grid"
        >
          {folded ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </button>
      </div>
      <div className={label}>
        <EnvironmentBadge />
        <ProjectSwitcher />
      </div>

      <nav className="flex flex-col">
        {GROUPS.map((group) => (
          <div key={group.label} className="flex flex-col gap-0.5">
            <div className={cn('px-2.5 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3', label)}>{group.label}</div>
            {folded && <div className="mx-2 my-2 hidden border-t border-hair md:block" aria-hidden />}
            {group.items.map((item) => {
              const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  aria-label={folded ? item.label : undefined}
                  title={folded ? item.label : undefined}
                  className={cn('flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors duration-[120ms] max-md:h-11 max-md:text-[14px]', folded && 'md:justify-center md:px-0', active ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1')}
                >
                  <Icon className="size-[18px] shrink-0" strokeWidth={1.7} />
                  <span className={cn('truncate', label)}>{item.label}</span>
                  {item.preview && <span className={cn('ml-auto rounded-full border border-acbd bg-acdim px-1.5 text-[10px] font-semibold leading-4 text-ac', label)}>Preview</span>}
                  {item.href === '/plugins' && plugins.length > 0 && <span className={cn('ml-auto font-mono text-[11px] font-normal text-t3', label)}>{online}/{plugins.length}</span>}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <Link
        href="/settings"
        aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
        aria-label={folded ? 'Settings' : undefined}
        title={folded ? 'Settings' : undefined}
        className={cn(
          'mb-2 mt-auto flex h-9 items-center gap-3 rounded-lg px-2.5 text-[13px] transition-colors duration-[120ms]',
          folded && 'md:justify-center md:px-0',
          pathname.startsWith('/settings') ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:bg-acdim hover:text-t1',
        )}
      >
        <Settings className="size-[18px] shrink-0" strokeWidth={1.7} />
        <span className={cn('truncate', label)}>Settings</span>
      </Link>
      <div className={cn('flex flex-col gap-2.5 px-2.5 pb-1', folded && 'md:items-center md:px-0')}>
        <div className="flex items-center gap-2 text-[12px] text-t3" title={connected ? 'Receiving live events' : 'Reconnecting to the event stream'}>
          <StatusDot status={connected ? 'online' : 'offline'} />
          <span className={label}>{connected ? 'Live' : 'Reconnecting…'}</span>
        </div>
        <div className={cn('flex flex-wrap items-center gap-1.5', label)}>
          <ThemeToggle />
          <LookToggle />
        </div>
      </div>
      <div className={cn('mt-2 border-t border-hair pt-2', label)}>
        <UserMenu />
      </div>
    </aside>
  );
}
