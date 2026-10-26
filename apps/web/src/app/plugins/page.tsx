'use client';
import { useEffect, useRef, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { useLiveEvents } from '@/lib/client/live';
import type { PluginSummary, RegistryEvent } from '@/lib/shared/types';
import { PluginCard } from '@/components/plugins/plugin-card';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Input, SectionLabel } from '@/components/ui/inputs';

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

export default function PluginsPage() {
  const [plugins, setPlugins] = useState<PluginSummary[]>();
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
          <Button variant="primary" size="sm" onClick={() => void scan()} loading={scanning}>
            {!scanning && <ScanSearch className="size-3.5" strokeWidth={1.7} />}
            {scanning ? 'Scanning…' : 'Scan network'}
          </Button>
        }
      />
      <PageBody className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3">
          {plugins?.map((plugin) => (
            <PluginCard key={plugin.id} plugin={plugin} onChange={setPlugins} />
          ))}
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
