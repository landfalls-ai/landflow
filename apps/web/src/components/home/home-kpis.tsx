/** Home's small parts that are decided by data: the KPI row, the offline-plugin line (docs/ux-simplification.md#home). */
import Link from 'next/link';
import { AlertTriangle } from 'lucide-react';
import { duration, plural } from '@/lib/client/format';
import type { PluginSummary } from '@/lib/shared/types';

export interface HomeStats {
  workflows: number;
  activeWorkflows: number;
  executions24h: number;
  failed24h: number;
  avgDurationMs: number;
}

export interface Kpi {
  label: string;
  icon: string;
  color: string;
  value?: number;
  sub?: string;
  danger?: boolean;
  /** Where the tile goes when pressed. */
  href?: string;
}

/** The four tiles: Workflows, Executions (24h), Failed (24h) and Needs you (the runs that wait for a person). */
export function homeKpis(stats: HomeStats | undefined, needsYou: number | undefined): Kpi[] {
  return [
    { label: 'Workflows', icon: 'lucide:workflow', color: 'var(--viz-1)', value: stats?.workflows, ...(stats && { sub: `${stats.activeWorkflows} active` }) },
    { label: 'Executions (24h)', icon: 'lucide:activity', color: 'var(--viz-3)', value: stats?.executions24h, ...(stats && { sub: `avg ${duration(stats.avgDurationMs)}` }) },
    {
      label: 'Failed (24h)',
      icon: 'lucide:triangle-alert',
      color: 'var(--rd)',
      value: stats?.failed24h,
      danger: !!stats?.failed24h,
      ...(stats && { sub: stats.executions24h ? `${Math.round((stats.failed24h / stats.executions24h) * 100)}% of runs` : 'no runs yet' }),
    },
    {
      label: 'Needs you',
      icon: 'lucide:hand',
      color: 'var(--warn)',
      value: needsYou,
      danger: !!needsYou,
      ...(needsYou !== undefined && { sub: needsYou ? 'waiting for a decision' : 'nothing waits' }),
      href: '/executions?status=waiting',
    },
  ];
}

export const offlinePlugins = (plugins: PluginSummary[] | undefined) => plugins?.filter((p) => p.status !== 'online').length ?? 0;

/** One line above the KPIs, only when a plugin is offline. */
export function PluginsOfflineLine({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <p role="status" className="flex min-h-11 items-center gap-2 rounded-xl border border-warnbd bg-warndim px-3 py-2 text-[13px] text-t1 md:min-h-0">
      <AlertTriangle className="size-4 shrink-0 text-warn" strokeWidth={1.8} />
      <span className="min-w-0 flex-1">{plural(count, 'plugin')} offline</span>
      <Link href="/plugins" className="shrink-0 font-semibold text-ac hover:underline">
        Open Plugins
      </Link>
    </p>
  );
}
