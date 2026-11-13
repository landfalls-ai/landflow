'use client';
/**
 * /plugins — the registry: every plugin as a small card (icon, status, nodes), unfolded on click to its endpoints,
 * transport policy, MCP exposure and nodes; search and an online/offline filter; `?plugin=<id>` unfolds one. The side
 * column adds an endpoint and shows the discovery feed.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ScanSearch, Store } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { useLiveEvents } from '@/lib/client/live';
import type { PluginSummary, RegistryEvent } from '@/lib/shared/types';
import { PluginCard } from '@/components/plugins/plugin-card';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button, buttonClass } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, SearchInput, SectionLabel } from '@/components/ui/inputs';
import { Segmented, SegmentedCount } from '../ui/segmented';

interface FeedItem {
  id: number;
  event: RegistryEvent;
  at: string;
}

const EVENT_STYLE: Record<RegistryEvent['type'], { label: string; className: string }> = {
  'plugin.registered': { label: 'registered', className: 'text-gn' },
  'plugin.updated': { label: 'updated', className: 'text-t2' },
  'plugin.heartbeat': { label: 'heartbeat', className: 'text-t3' },
  'plugin.offline': { label: 'offline', className: 'text-warn' },
  'plugin.removed': { label: 'removed', className: 'text-t3' },
  'plugin.error': { label: 'error', className: 'text-rd' },
  'plugin.transport': { label: 'transport', className: 'text-ac' },
  'scan.started': { label: 'scan', className: 'text-t2' },
  'scan.probe': { label: 'found', className: 'text-gn' },
  'scan.finished': { label: 'scan done', className: 'text-t2' },
};

type StatusFilter = 'all' | 'online' | 'offline';

const matches = (plugin: PluginSummary, query: string) => {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [plugin.id, plugin.info.name, plugin.info.description, plugin.info.language, ...plugin.nodes.flatMap((n) => [n.name, n.displayName])].some((text) => text?.toLowerCase().includes(q));
};

export function PluginRegistry() {
  const router = useRouter();
  const params = useSearchParams();
  const [plugins, setPlugins] = useState<PluginSummary[]>();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [expanded, setExpanded] = useState<string | undefined>(params.get('plugin') ?? undefined);
  const opened = useRef<HTMLDivElement>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [beatCount, setBeatCount] = useState(0);
  const [scanning, setScanning] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [adding, setAdding] = useState(false);
  const seq = useRef(0);

  const load = () => api<{ plugins: PluginSummary[] }>('/api/plugins').then((r) => setPlugins(r.plugins));
  useEffect(() => {
    void load();
  }, []);

  useLiveEvents((message) => {
    if (message.channel !== 'registry') return;
    const event = message.event;
    if (event.type === 'plugin.heartbeat') {
      setBeatCount((n) => n + 1);
      // Lease timers live on the endpoints; refresh quietly.
      void load();
      return;
    }
    // Only probes that hit something are worth a feed line.
    if (event.type === 'scan.probe' && !event.found) return;
    if (event.type === 'scan.started') setScanning(true);
    if (event.type === 'scan.finished') setScanning(false);
    setFeed((f) => [{ id: ++seq.current, event, at: message.at }, ...f].slice(0, 40));
    void load();
  });

  const scan = async () => {
    setScanning(true);
    try {
      const r = await api<{ found: number; probed: number; durationMs: number; plugins: PluginSummary[] }>('/api/plugins/scan', { method: 'POST', json: {} });
      setPlugins(r.plugins);
      toast.success(`Scanned ${r.probed} ports in ${r.durationMs} ms: ${r.found} new endpoint(s)`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setScanning(false);
    }
  };

  const add = async () => {
    if (!endpoint.trim()) return;
    setAdding(true);
    try {
      const r = await api<{ pluginId: string; plugins: PluginSummary[] }>('/api/plugins', { method: 'POST', json: { endpoint } });
      setPlugins(r.plugins);
      setEndpoint('');
      toast.success(`Registered ${r.pluginId}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const online = plugins?.filter((p) => p.status === 'online').length ?? 0;
  const nodeCount = plugins?.reduce((sum, p) => sum + p.nodes.length, 0) ?? 0;
  const shown = useMemo(() => plugins?.filter((p) => (status === 'all' || (status === 'online') === (p.status === 'online')) && matches(p, query)), [plugins, status, query]);
  const counts: Record<StatusFilter, number> = { all: plugins?.length ?? 0, online, offline: (plugins?.length ?? 0) - online };

  const toggle = (id: string) => {
    const next = expanded === id ? undefined : id;
    setExpanded(next);
    router.replace(next ? `/plugins?plugin=${encodeURIComponent(next)}` : '/plugins', { scroll: false });
  };
  // A link to one plugin (`?plugin=`) scrolls its card into view once the list is in.
  const linked = useRef(params.get('plugin'));
  useEffect(() => {
    if (!plugins || !linked.current) return;
    linked.current = null;
    opened.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [plugins]);

  return (
    <>
      <PageHeader
        title="Plugins"
        meta={
          plugins && (
            <span>
              {online}/{plugins.length} online · {nodeCount} node types · {beatCount} heartbeats
            </span>
          )
        }
        actions={
          <>
            <Link href="/marketplace" className={buttonClass('ghost', 'sm')}>
              <Store className="size-3.5" strokeWidth={1.7} /> Marketplace
            </Link>
            <Button variant="primary" size="sm" onClick={() => void scan()} loading={scanning}>
              {!scanning && <ScanSearch className="size-3.5" strokeWidth={1.7} />}
              {scanning ? 'Scanning…' : 'Scan network'}
            </Button>
          </>
        }
      />
      <PageBody className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          {(plugins?.length ?? 0) > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <SearchInput value={query} onChange={setQuery} placeholder="Search plugins and nodes…" label="Search plugins" className="w-full max-w-[320px] max-md:max-w-none" />
              <Segmented
                label="Status"
                value={status}
                onChange={setStatus}
                options={(['all', 'online', 'offline'] as const).map((s) => ({ value: s, label: <>{s === 'all' ? 'All' : s === 'online' ? 'Online' : 'Offline'} <SegmentedCount>{counts[s]}</SegmentedCount></> }))}
              />
            </div>
          )}
          {shown && shown.length > 0 && (
            <div className="grid grid-flow-row-dense grid-cols-1 gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
              {shown.map((plugin) => (
                <div key={plugin.id} ref={expanded === plugin.id ? opened : undefined} className={cn('min-w-0 scroll-mt-[72px]', expanded === plugin.id && 'col-span-full')}>
                  <PluginCard plugin={plugin} onChange={setPlugins} expanded={expanded === plugin.id} onToggle={() => toggle(plugin.id)} />
                </div>
              ))}
            </div>
          )}
          {plugins && plugins.length > 0 && shown?.length === 0 && (
            <Card className="py-6">
              <EmptyState compact title="No plugin matches" hint="Try another search or status." />
            </Card>
          )}
          {!plugins && (
            <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="h-[132px] animate-pulse-soft rounded-2xl bg-wl" />
              ))}
            </div>
          )}
          {plugins?.length === 0 && (
            <Card>
              <EmptyState title="No plugins yet" hint="Plugins announce themselves over HTTP or gRPC and heartbeat to keep their lease. Start one, scan the network, or add an endpoint." />
            </Card>
          )}
        </div>

        <aside className="flex flex-col gap-3 xl:sticky xl:top-[72px]">
          <Card>
            <SectionLabel>Add endpoint</SectionLabel>
            <p className="mt-1 text-[12px] text-t3">Register a plugin the scan can’t reach.</p>
            <div className="mt-3 flex gap-2">
              <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void add()} placeholder="grpc://10.0.0.7:7203 or http://…" className="font-mono text-[12px]" />
              <Button onClick={() => void add()} loading={adding} className="h-9">
                Add
              </Button>
            </div>
          </Card>

          <Card className="overflow-hidden p-0">
            <div className="flex h-11 items-center gap-2 border-b border-hair px-4">
              <SectionLabel>Discovery feed</SectionLabel>
              <span className="ml-auto font-mono text-[11px] tabular-nums text-t3">{beatCount} heartbeats</span>
            </div>
            <div className="max-h-[440px] overflow-y-auto py-1.5">
              {feed.map((item) => {
                const style = EVENT_STYLE[item.event.type];
                return (
                  <div key={item.id} className="flex gap-2.5 px-4 py-1 font-mono text-[12px] leading-5">
                    <span className="shrink-0 tabular-nums text-t3">{new Date(item.at).toLocaleTimeString([], { hour12: false })}</span>
                    <span className={cn('w-[68px] shrink-0 truncate', style.className)} title={item.event.type}>
                      {style.label}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-t1">{item.event.message}</span>
                  </div>
                );
              })}
              {feed.length === 0 && (
                <div className="px-4 py-6 text-center text-[12px] leading-relaxed text-t3">
                  Waiting for plugins. Start one with <code className="rounded border border-hair bg-wl px-1 font-mono text-[11px] text-t2">pnpm plugin:go</code> or press Scan network.
                </div>
              )}
            </div>
          </Card>
        </aside>
      </PageBody>
    </>
  );
}
