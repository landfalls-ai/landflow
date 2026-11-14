'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { useLiveEvents } from '@/lib/client/live';
import { useNeedsYou } from '@/lib/client/run-trace';
import type { ExecutionSummary, PluginSummary } from '@/lib/shared/types';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { CountUp } from '@/components/ui/count-up';
import { NodeIcon } from '@/components/ui/icon';
import { SectionLabel } from '@/components/ui/inputs';
import { SuggestionsInbox } from '@/components/brain/suggestions-inbox';
import { LiveRuns } from '@/components/run-trace/run-lists';
import { RunLines } from '@/components/run-trace/run-line';
import { homeKpis, offlinePlugins, PluginsOfflineLine, type HomeStats, type Kpi as KpiData } from '@/components/home/home-kpis';
import { StatCard } from '@/components/ui/stat-card';

function Kpi({ kpi, index }: { kpi: KpiData; index: number }) {
  const card = (
    <StatCard
      index={index}
      label={kpi.label}
      color={kpi.color}
      danger={kpi.danger}
      icon={<NodeIcon icon={kpi.icon} size={14} style={{ color: kpi.color }} strokeWidth={2} />}
      value={kpi.value === undefined ? '—' : <CountUp value={kpi.value} />}
      sub={kpi.sub && <span className="truncate">{kpi.sub}</span>}
    />
  );
  return kpi.href ? (
    <Link href={kpi.href} className="rounded-2xl focus-visible:outline-2 focus-visible:outline-ac">
      {card}
    </Link>
  ) : (
    card
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
  const [stats, setStats] = useState<HomeStats>();
  const [plugins, setPlugins] = useState<PluginSummary[]>();
  const [executions, setExecutions] = useState<ExecutionSummary[]>();
  const [creating, setCreating] = useState(false);
  const { items: needsYou } = useNeedsYou();

  const load = () => {
    void api<{ stats: HomeStats }>('/api/workflows').then((r) => setStats(r.stats));
    void api<{ plugins: PluginSummary[] }>('/api/plugins').then((r) => setPlugins(r.plugins));
    void api<{ executions: ExecutionSummary[] }>('/api/executions?limit=8').then((r) => setExecutions(r.executions.slice(0, 8))); // live runs come first and may add to the 8
  };
  useEffect(load, []);
  // The Classic look is gone: nobody stays on a stored `landflow-look=classic`.
  useEffect(() => {
    try {
      localStorage.removeItem('landflow-look');
      delete document.documentElement.dataset.look;
    } catch {}
  }, []);
  useLiveEvents((event) => {
    if (event.channel === 'registry' && event.event.type !== 'plugin.heartbeat' && !event.event.type.startsWith('scan.')) load();
    if (event.channel === 'execution' && (event.event.type === 'execution.finished' || event.event.type === 'execution.started' || event.event.type === 'execution.paused' || event.event.type === 'execution.resumed')) load();
  });

  // A blank workflow, the way the workflows list makes one, then the editor.
  const create = async () => {
    setCreating(true);
    try {
      const { workflow } = await api<{ workflow: { id: string } }>('/api/workflows', { method: 'POST', json: { name: 'Untitled workflow', nodes: [], connections: [] } });
      router.push(`/workflows/${workflow.id}`);
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };

  const recent = executions?.filter((e) => e.status !== 'running').slice(0, 6);

  return (
    <>
      <PageHeader
        title="Home"
        actions={
          <Button size="sm" variant="primary" onClick={() => void create()} loading={creating}>
            {!creating && <Plus className="size-3.5" strokeWidth={2} />} New workflow
          </Button>
        }
      />
      <PageBody className="flex flex-col gap-5">
        <PluginsOfflineLine count={offlinePlugins(plugins)} />
        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {homeKpis(stats, needsYou?.length).map((kpi, i) => (
            <Kpi key={kpi.label} kpi={kpi} index={i} />
          ))}
        </section>

        <SuggestionsInbox />

        {executions && <LiveRuns executions={executions} />}

        <Panel title="Recent executions" href="/executions" linkLabel="View all">
          {recent?.length ? (
            <div className="p-3">
              <RunLines runs={recent.map((e) => ({ id: e.id, href: `/runs/${e.id}`, name: e.workflowName, startedAt: e.startedAt }))} />
            </div>
          ) : null}
          {executions?.length === 0 && (
            <EmptyState
              compact
              title="No executions yet"
              hint="Run a workflow and it shows up here. Or open the demo to see one run."
              action={
                <Button size="sm" variant="outline" onClick={() => router.push('/workflows/wf_polyglot_pipeline')}>
                  Open polyglot demo
                </Button>
              }
              className="py-8"
            />
          )}
          {/* Every listed run is still going: they show above, as live runs, so the panel says so instead of staying blank. */}
          {!!executions?.length && !recent?.length && <p className="px-4 py-6 text-center text-[12.5px] text-t3">Nothing has finished yet: the runs in progress are above.</p>}
        </Panel>
      </PageBody>
    </>
  );
}
