'use client';
import { useEffect, useState } from 'react';
import { RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo, TRANSPORT_META } from '@/lib/client/format';
import type { PluginSummary } from '@/lib/shared/types';
import { Badge, LanguageBadge, StatusDot, TransportBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { AppIcon, NodeIcon } from '../ui/icon';
import { descriptorColor } from '@/lib/client/node-style';

const LEASE_MS = 30_000;

function LeaseBar({ expiresAt }: { expiresAt?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, []);
  if (!expiresAt) return null;
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const pct = Math.min(100, (remaining / LEASE_MS) * 100);
  return (
    <div className="flex items-center gap-2" title="Lease, renewed by heartbeats">
      <div className="h-1 w-14 overflow-hidden rounded-full bg-bd">
        <div className="h-full rounded-full bg-ac2 transition-[width] duration-500 ease-linear" style={{ width: `${pct}%` }} />
      </div>
      <span className="w-7 text-right font-mono text-[11px] tabular-nums text-t3">{Math.round(remaining / 1000)}s</span>
    </div>
  );
}

export function PluginCard({ plugin, onChange }: { plugin: PluginSummary; onChange: (plugins: PluginSummary[]) => void }) {
  const builtin = plugin.source === 'builtin';
  const [busy, setBusy] = useState(false);
  const transports = [...new Set(plugin.endpoints.map((e) => e.transport))];

  const setPreferred = async (transport: 'http' | 'grpc' | null) => {
    const r = await api<{ plugins: PluginSummary[] }>(`/api/plugins/${plugin.id}`, { method: 'PATCH', json: { preferredTransport: transport } });
    onChange(r.plugins);
    toast(`${plugin.info.name} → ${transport ? TRANSPORT_META[transport].label : 'auto'} transport`);
  };
  const refresh = async () => {
    setBusy(true);
    try {
      onChange((await api<{ plugins: PluginSummary[] }>(`/api/plugins/${plugin.id}/refresh`, { method: 'POST' })).plugins);
      toast.success(`Re-pulled manifest of ${plugin.info.name}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    await api(`/api/plugins/${plugin.id}`, { method: 'DELETE' });
    onChange((await api<{ plugins: PluginSummary[] }>('/api/plugins')).plugins);
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-hair bg-sf">
      {/* header */}
      <div className="flex items-start gap-3 px-4 pb-3 pt-3.5">
        <AppIcon icon={plugin.info.icon} color={plugin.info.color} size={40} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h3 className="truncate text-[13px] font-semibold text-t1">{plugin.info.name}</h3>
            <span className="font-mono text-[11px] text-t3">v{plugin.info.version}</span>
            <span className="flex items-center gap-1.5 text-[12px] text-t3">
              <StatusDot status={plugin.status} />
              {plugin.status}
            </span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <LanguageBadge language={plugin.info.language} />
            <Badge tone="muted">{plugin.source}</Badge>
            {plugin.info.sdk && <span className="font-mono text-[11px] text-t3">{plugin.info.sdk.name}</span>}
          </div>
        </div>
        {!builtin && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button variant="ghost" size="icon-sm" onClick={() => void refresh()} disabled={busy} title="Re-pull manifest" aria-label="Re-pull manifest">
              <RefreshCw className={cn('size-3.5', busy && 'animate-spin')} strokeWidth={1.7} />
            </Button>
            <Button variant="ghost" size="icon-sm" onClick={() => void remove()} title="Forget plugin" aria-label="Forget plugin" className="hover:bg-rddim hover:text-rd">
              <Trash2 className="size-3.5" strokeWidth={1.7} />
            </Button>
          </div>
        )}
      </div>
      {plugin.info.description && <p className="-mt-1 px-4 pb-3 text-[13px] text-t2">{plugin.info.description}</p>}

      {/* endpoints */}
      <div className="divide-y divide-hair border-t border-hair">
        {builtin ? (
          <div className="flex items-center gap-2 px-4 py-2 text-[12px] text-t3">
            <TransportBadge transport="in-process" /> loaded into the host: same INodeType interface, zero network hops
          </div>
        ) : (
          plugin.endpoints.map((endpoint) => {
            const active = endpoint.endpoint === plugin.activeEndpoint;
            return (
              <div key={endpoint.endpoint} title={endpoint.lastError} className={cn('flex items-center gap-2 px-4 py-2', active && 'bg-sf2')}>
                <StatusDot status={endpoint.status} />
                <TransportBadge transport={endpoint.transport} />
                <span className="truncate font-mono text-[12px] text-t1">{endpoint.endpoint}</span>
                {active && <Badge tone="accent">active</Badge>}
                <span className="ml-auto flex shrink-0 items-center gap-3">
                  {endpoint.latencyMs !== undefined && <span className="font-mono text-[11px] tabular-nums text-t3">{endpoint.latencyMs}ms</span>}
                  {endpoint.source === 'announce' && endpoint.status === 'online' ? <LeaseBar expiresAt={endpoint.leaseExpiresAt} /> : <span className="text-[12px] text-t3">{timeAgo(endpoint.lastSeen)}</span>}
                </span>
              </div>
            );
          })
        )}
      </div>

      {transports.length > 1 && (
        <div className="flex items-center gap-2 border-t border-hair px-4 py-2 text-[12px] text-t3">
          Execute via
          <div className="flex rounded-lg border border-hair bg-wl p-0.5">
            {([null, 'grpc', 'http'] as const).map((t) => {
              const active = (plugin.preferredTransport ?? null) === t;
              return (
                <button
                  key={t ?? 'auto'}
                  onClick={() => void setPreferred(t)}
                  aria-pressed={active}
                  className={cn('rounded-md border px-2.5 py-px text-[12px] transition-colors duration-[120ms]', active ? 'border-bd bg-sf font-semibold text-t1' : 'border-transparent text-t3 hover:text-t1')}
                >
                  {t ? TRANSPORT_META[t].label : 'Auto'}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* nodes */}
      {plugin.nodes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 border-t border-hair px-4 py-3">
          {plugin.nodes.map((node) => (
            <span
              key={node.name}
              title={node.description}
              className="inline-flex items-center gap-1.5 rounded-md border border-hair bg-wl px-2 py-0.5 text-[12px] text-t2 transition-colors duration-[120ms] hover:border-bd hover:text-t1"
            >
              <NodeIcon icon={node.icon} size={12} strokeWidth={2} style={{ color: descriptorColor(node, plugin.info.color) }} />
              {node.displayName}
              {node.usableAsTool && <span className="font-mono text-[11px] text-t3">tool</span>}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
