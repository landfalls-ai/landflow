'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { duration, timeAgo } from '@/lib/client/format';
import { useLiveEvents } from '@/lib/client/live';
import type { ExecutionSummary, PluginSummary } from '@/lib/shared/types';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge, executionTone, LanguageBadge, StatusDot, TransportBadge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { CountUp } from '@/components/ui/count-up';
import { AppIcon, NodeIcon } from '@/components/ui/icon';
import { SectionLabel } from '@/components/ui/inputs';
import { SuggestionsInbox } from '@/components/brain/suggestions-inbox';

interface Stats {
  workflows: number;
  activeWorkflows: number;
  executions24h: number;
  failed24h: number;
  avgDurationMs: number;
}

function Kpi({ label, value, sub, danger, color, icon, index }: { label: string; value?: number; sub?: string; danger?: boolean; color: string; icon: string; index: number }) {
  return (
    <Card className="relative animate-fade-up overflow-hidden" style={{ animationDelay: `${index * 70}ms` }}>
      <span className="absolute inset-x-0 top-0 h-[3px]" style={{ background: color }} />
      <div className="flex items-center justify-between">
        <SectionLabel>{label}</SectionLabel>
        <span className="grid size-7 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${color} 13%, var(--sf))` }}>
          <NodeIcon icon={icon} size={14} style={{ color }} strokeWidth={2} />
        </span>
      </div>
      <div className={cn('mt-1 text-[28px] font-semibold leading-none tabular-nums', danger ? 'text-rd' : 'text-t1')}>{value === undefined ? '—' : <CountUp value={value} />}</div>
      {sub && <div className="mt-2 truncate text-[12px] text-t3">{sub}</div>}
    </Card>
  );
}

function Panel({ title, href, linkLabel, children }: { title: string; href: string; linkLabel: string; children: React.ReactNode }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex h-11 items-center justify-between border-b border-hair px-4">
        <SectionLabel>{title}</SectionLabel>
        <Link href={href} className="text-[12px] text-t3 transition-colors duration-[120ms] hover:text-t1">
          {linkLabel}
        </Link>
      </div>
      {children}
    </Card>
  );
}

export default function Overview() {
  const router = useRouter();
  const [stats, setStats] = useState<Stats>();
  const [plugins, setPlugins] = useState<PluginSummary[]>();
  const [executions, setExecutions] = useState<ExecutionSummary[]>();
  const [nodeTypes, setNodeTypes] = useState(0);

  const load = () => {
    void api<{ stats: Stats }>('/api/workflows').then((r) => setStats(r.stats));
    void api<{ plugins: PluginSummary[] }>('/api/plugins').then((r) => setPlugins(r.plugins));
    void api<{ executions: ExecutionSummary[] }>('/api/executions?limit=8').then((r) => setExecutions(r.executions));
    void api<{ nodeTypes: unknown[] }>('/api/node-types').then((r) => setNodeTypes(r.nodeTypes.length));
  };
  useEffect(load, []);
  useLiveEvents((event) => {
    if (event.channel === 'registry' && event.event.type !== 'plugin.heartbeat' && !event.event.type.startsWith('scan.')) load();
    if (event.channel === 'execution' && (event.event.type === 'execution.finished' || event.event.type === 'execution.started' || event.event.type === 'execution.paused' || event.event.type === 'execution.resumed')) load();
  });

  const online = plugins?.filter((p) => p.status === 'online').length ?? 0;
  const languages = new Set(plugins?.map((p) => p.info.language)).size;

  return (
    <>
      <PageHeader
        title="Home"
        meta={plugins && <span>{online} plugins online · {languages} languages · {nodeTypes} node types</span>}
        actions={
          <>
            <Button size="sm" onClick={() => router.push('/developers')}>
              Build a plugin
            </Button>
            <Button size="sm" variant="primary" onClick={() => router.push('/workflows/wf_polyglot_pipeline')}>
              Open polyglot demo <ArrowRight className="size-3.5" strokeWidth={1.7} />
            </Button>
          </>
        }
      />
      <PageBody className="flex flex-col gap-5">
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi index={0} label="Workflows" icon="lucide:workflow" color="var(--viz-1)" value={stats?.workflows} sub={stats && `${stats.activeWorkflows} active`} />
          <Kpi index={1} label="Executions (24h)" icon="lucide:activity" color="var(--viz-3)" value={stats?.executions24h} sub={stats && `avg ${duration(stats.avgDurationMs)}`} />
          <Kpi
            index={2}
            label="Failed (24h)"
            icon="lucide:triangle-alert"
            color="var(--rd)"
            value={stats?.failed24h}
            danger={!!stats?.failed24h}
            sub={stats && (stats.executions24h ? `${Math.round((stats.failed24h / stats.executions24h) * 100)}% of runs` : 'no runs yet')}
          />
          <Kpi index={3} label="Plugins online" icon="lucide:puzzle" color="var(--viz-7)" value={plugins ? online : undefined} sub={plugins && `${plugins.length} registered · ${nodeTypes} node types`} />
        </section>

        <SuggestionsInbox />

        <section className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[1.4fr_1fr]">
          <Panel title="Recent executions" href="/executions" linkLabel="View all">
            <div className="divide-y divide-hair">
              {executions?.map((execution) => (
                <Link key={execution.id} href={`/workflows/${execution.workflowId}/executions/${execution.id}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-[120ms] hover:bg-sf2">
                  <StatusDot status={execution.paused ? 'paused' : execution.status} pulse={execution.status === 'running' && !execution.paused} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold text-t1">{execution.workflowName}</span>
                      {execution.rerunOf && <Badge tone="muted">re-run</Badge>}
                      {execution.debug && <Badge tone="neutral">debug</Badge>}
                      {execution.paused && <Badge tone="warning">paused</Badge>}
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-t3">
                      {execution.mode} · {execution.nodesRun} node runs
                    </div>
                  </div>
                  <Badge tone={executionTone(execution.status)}>{execution.status}</Badge>
                  <div className="w-[68px] shrink-0 text-right">
                    <div className="font-mono text-[12px] text-t2">{execution.status === 'running' ? '—' : duration(execution.durationMs)}</div>
                    <div className="text-[12px] text-t3">{timeAgo(execution.startedAt)}</div>
                  </div>
                </Link>
              ))}
            </div>
            {executions?.length === 0 && <EmptyState compact title="No executions yet" hint="Run a workflow and it shows up here." className="py-8" />}
          </Panel>

          <Panel title="Plugins" href="/plugins" linkLabel="Registry">
            <div className="divide-y divide-hair">
              {plugins?.map((plugin) => (
                <Link key={plugin.id} href={`/plugins?plugin=${encodeURIComponent(plugin.id)}`} className="flex items-center gap-3 px-4 py-2.5 transition-colors duration-[120ms] hover:bg-sf2">
                  <AppIcon icon={plugin.info.icon} color={plugin.info.color} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate text-[13px] font-semibold text-t1">{plugin.info.name}</span>
                      <span className="font-mono text-[11px] text-t3">v{plugin.info.version}</span>
                    </div>
                    <div className="mt-0.5 text-[12px] text-t3">{plugin.nodes.length} {plugin.nodes.length === 1 ? 'node' : 'nodes'}</div>
                  </div>
                  <LanguageBadge language={plugin.info.language} className="hidden sm:inline-flex" />
                  <TransportBadge transport={plugin.transport} />
                  <StatusDot status={plugin.status} />
                </Link>
              ))}
            </div>
            {plugins?.length === 0 && <EmptyState compact title="No plugins registered" hint="Start one or scan the network from the Plugins page." className="py-8" />}
          </Panel>
        </section>
      </PageBody>
    </>
  );
}
