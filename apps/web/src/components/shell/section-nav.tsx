'use client';
/**
 * The section tabs under the rail's Workflows, Runs and Plugins items (docs/ux-simplification.md#navigation): the pages
 * that used to be rail items of their own, one click away from their group. The strip sits above a list page and not
 * above a page of its own (the editor, a run's trace, a compare), and on a phone the row scrolls sideways. The logic is
 * plain functions, so a test can read it without a browser.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { api } from '@/lib/client/api';
import type { PluginSummary } from '@/lib/shared/types';
import { cn } from '@/lib/utils';

export type SectionGroup = 'workflows' | 'runs' | 'plugins';
export interface SectionTab {
  href: string;
  label: string;
  /** Shown only when this plugin is registered. */
  plugin?: string;
}

export const SECTION_GROUPS: Record<SectionGroup, SectionTab[]> = {
  workflows: [
    { href: '/workflows', label: 'Workflows' },
    { href: '/templates', label: 'Templates' },
    { href: '/runbooks', label: 'Runbooks', plugin: 'landfall' },
  ],
  // B20 changes Activity to /runs.
  runs: [
    { href: '/executions', label: 'Activity' },
    { href: '/insights', label: 'Insights' },
    // B20 removes this: until the pages merge, Search runs has no other entry point.
    { href: '/runs', label: 'Search' },
  ],
  plugins: [
    { href: '/plugins', label: 'Installed' },
    { href: '/marketplace', label: 'Marketplace' },
    { href: '/developers', label: 'Build your own' },
  ],
};

/** The rail: nine places. A group's item is active on every page of its group. */
export const RAIL_ITEMS: Array<{ href: string; label: string }> = [
  { href: '/', label: 'Home' },
  { href: '/workflows', label: 'Workflows' },
  { href: '/executions', label: 'Runs' },
  { href: '/agents', label: 'Agents' },
  { href: '/brain', label: 'Brain' },
  { href: '/data-tables', label: 'Data tables' },
  { href: '/credentials', label: 'Credentials' },
  { href: '/plugins', label: 'Plugins' },
  { href: '/settings', label: 'Settings' },
];

const under = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);

/** The section a path belongs to, if any (the rail highlights its item). */
export function groupOf(pathname: string): SectionGroup | undefined {
  if (['/workflows', '/templates', '/runbooks'].some((b) => under(pathname, b))) return 'workflows';
  if (['/executions', '/runs', '/insights'].some((b) => under(pathname, b))) return 'runs';
  if (['/plugins', '/marketplace', '/developers'].some((b) => under(pathname, b))) return 'plugins';
  return undefined;
}

/** Whether a rail item is the current page's. */
export function railActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  const group = groupOf(pathname);
  if (href === '/workflows') return group === 'workflows';
  if (href === '/executions') return group === 'runs';
  if (href === '/plugins') return group === 'plugins';
  return under(pathname, href);
}

/** The group whose strip a path shows: list pages only, never the editor (/workflows/<id>), a run's trace or a compare. */
export function stripGroup(pathname: string): SectionGroup | undefined {
  const group = groupOf(pathname);
  if (!group) return undefined;
  return SECTION_GROUPS[group].some((t) => t.href === pathname) || pathname === '/runs' ? group : undefined;
}

/** A group's tabs, less those that need a plugin that is not registered. */
export function visibleTabs(group: SectionGroup, plugins: Array<{ id: string }>): SectionTab[] {
  return SECTION_GROUPS[group].filter((t) => !t.plugin || plugins.some((p) => p.id === t.plugin));
}

/** The rail's red dot on Plugins: only when a plugin is not online, with its title. */
export function offlineDot(plugins: Array<{ status: string }>): { dot: boolean; title?: string } {
  const offline = plugins.filter((p) => p.status !== 'online').length;
  return offline === 0 ? { dot: false } : { dot: true, title: `${offline} ${offline === 1 ? 'plugin' : 'plugins'} offline` };
}

/**
 * The rail's "Reconnecting…" line: only after the event stream was connected once in this tab and then dropped. The
 * stream starts closed on every load (and on the server), so `!connected` alone would flash the line on each page.
 */
export function showReconnecting(everConnected: boolean, connected: boolean): boolean {
  return everConnected && !connected;
}

export function SectionNav({ group }: { group: SectionGroup }) {
  const pathname = usePathname();
  const [plugins, setPlugins] = useState<Array<Pick<PluginSummary, 'id'>>>([]);
  useEffect(() => {
    if (group !== 'workflows' || stripGroup(pathname) !== group) return;
    api<{ plugins: PluginSummary[] }>('/api/plugins').then((r) => setPlugins(r.plugins)).catch(() => {});
  }, [group, pathname]);
  if (stripGroup(pathname) !== group) return null;
  return (
    <nav aria-label="Section" className="border-b border-hair bg-sf2/50 px-6 max-md:overflow-x-auto max-md:px-4 max-md:[scrollbar-width:none] max-md:[&::-webkit-scrollbar]:hidden">
      <div role="tablist" aria-label="Section" className="flex items-center gap-1 max-md:w-max">
        {visibleTabs(group, plugins).map((tab) => {
          const current = pathname === tab.href;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              role="tab"
              aria-selected={current}
              aria-current={current ? 'page' : undefined}
              className={cn(
                '-mb-px flex h-9 shrink-0 whitespace-nowrap max-md:h-11 items-center border-b-2 px-3 text-[13px] transition-colors duration-[120ms] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ac',
                current ? 'border-ac font-semibold text-t1' : 'border-transparent text-t2 hover:text-t1',
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
