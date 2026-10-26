'use client';
import { useEffect, useState } from 'react';
import { ChevronDown, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo, transportLabel } from '@/lib/client/format';
import type { McpToolsResponse, McpToolView } from '@/lib/shared/mcp';
import type { PluginSummary } from '@/lib/shared/types';
import type { BrokerQueueStats, TransportObjective, TransportPolicy, TransportReason } from '@/lib/shared/transports';
import { Badge, LanguageBadge, StatusDot, TransportBadge } from '../ui/badge';
import { Button } from '../ui/button';
import { AppIcon, NodeIcon } from '../ui/icon';
import { Select, Switch } from '../ui/inputs';
import { descriptorColor } from '@/lib/client/node-style';

const LEASE_MS = 30_000;

/** `landflow.transport.reason` for people (docs/transports.md, "Explainability"). */
export const REASON_LABELS: Record<TransportReason, { label: string; title: string }> = {
  pinned: { label: 'pinned', title: 'The policy pins this transport' },
  only: { label: 'only one', title: 'The only transport both sides have right now' },
  'auto.latency': { label: 'auto · latency', title: 'Auto: the fastest transport for this call' },
  'auto.spillover': { label: 'auto · spill-over', title: 'Auto: the direct transport is near its limit; this one holds the rest' },
  'auto.failover': { label: 'auto · failover', title: 'Auto: the call provably was not delivered elsewhere' },
  'auto.breaker': { label: 'auto · breaker', title: 'Auto: another transport’s circuit breaker is open' },
  'auto.size': { label: 'auto · size', title: 'Auto: the call is too large for the other transports' },
};

const OBJECTIVES: Array<{ value: TransportObjective; label: string }> = [
  { value: 'balanced', label: 'Balanced' },
  { value: 'latency', label: 'Latency' },
  { value: 'throughput', label: 'Throughput' },
];

type PickerMode = 'auto' | 'pinned' | 'allowed';

/** A broker's numbers in one line: `depth 3 · 2 consumers · lag 1 · 2×16`, with the sample time in the title. */
function queueSummary(stats: BrokerQueueStats): { text: string; title: string } {
  const parts = [
    stats.depth !== undefined && `depth ${stats.depth}`,
    stats.consumers !== undefined && `${stats.consumers} consumer${stats.consumers === 1 ? '' : 's'}`,
    stats.lag !== undefined && `lag ${stats.lag}`,
    stats.instances !== undefined && `${stats.instances} instance${stats.instances === 1 ? '' : 's'}${stats.maxConcurrency ? ` × ${Math.round(stats.maxConcurrency / Math.max(1, stats.instances))}` : ''}`,
  ].filter((p): p is string => Boolean(p));
  const title = [
    'Request channel on the broker (sampled every 5 s): events waiting, consumers attached, consumer-group lag; announced instances × their maxConcurrency.',
    stats.sampledAt && `Sampled ${new Date(stats.sampledAt).toLocaleTimeString()}.`,
  ]
    .filter(Boolean)
    .join(' ');
  return { text: parts.join(' · '), title };
}

function QueueNumbers({ stats, className }: { stats?: BrokerQueueStats; className?: string }) {
  if (!stats) return null;
  const { text, title } = queueSummary(stats);
  if (!text) return null;
  return (
    <span className={cn('font-mono text-[11px] tabular-nums text-t3', className)} title={title}>
      {text}
    </span>
  );
}
const modeOf = (policy: TransportPolicy): PickerMode => (policy.mode === 'pinned' ? 'pinned' : policy.allowed?.length ? 'allowed' : 'auto');

/**
 * The plugin's transports (live state per kind), the policy picker (Auto, pinned to one, or an allow-list; the
 * objective) and what the next call takes with the reason.
 */
function TransportPolicyPicker({ plugin, onChange }: { plugin: PluginSummary; onChange: (plugins: PluginSummary[]) => void }) {
  const policy: TransportPolicy = plugin.policy ?? { mode: 'auto', objective: 'balanced' };
  const kinds = (plugin.transports ?? []).map((t) => t.kind);
  const [busy, setBusy] = useState(false);
  const mode = modeOf(policy);

  const save = async (next: TransportPolicy) => {
    setBusy(true);
    try {
      const r = await api<{ plugins: PluginSummary[] }>(`/api/plugins/${plugin.id}`, { method: 'PATCH', json: { policy: next } });
      onChange(r.plugins);
      const how = next.mode === 'pinned' ? `pinned to ${transportLabel(next.pinned ?? '')}` : next.allowed?.length ? `Auto over ${next.allowed.map(transportLabel).join(', ')}` : 'Auto';
      toast(`${plugin.info.name}: ${how}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const setMode = (next: PickerMode) => {
    if (next === mode) return;
    if (next === 'auto') return void save({ mode: 'auto', objective: policy.objective });
    if (next === 'pinned') return void save({ mode: 'pinned', pinned: plugin.choice?.kind ?? kinds[0], objective: policy.objective });
    void save({ mode: 'auto', allowed: kinds, objective: policy.objective });
  };
  const toggleAllowed = (kind: string) => {
    const allowed = policy.allowed ?? kinds;
    const next = allowed.includes(kind) ? allowed.filter((k) => k !== kind) : [...allowed, kind];
    if (!next.length) return toast.error('Allow at least one transport');
    void save({ mode: 'auto', allowed: next, objective: policy.objective });
  };

  return (
    <div className="space-y-2 border-t border-hair px-4 py-2.5 text-[12px] text-t3">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-0.5">Transports</span>
        {(plugin.transports ?? []).map((t) => (
          <span
            key={t.kind}
            className={cn('inline-flex items-center gap-1 rounded-md border border-hair bg-wl px-1.5 py-px', t.excluded && 'opacity-50')}
            title={`${t.endpoints.join(', ') || 'no endpoint yet'}${t.excluded ? ' · kept out by the policy' : ''}${t.stats?.maxConcurrency ? ` · up to ${t.stats.maxConcurrency} calls at once` : ''}`}
          >
            <StatusDot status={t.online ? 'online' : 'offline'} />
            <span className="font-mono text-[11px] text-t2">{transportLabel(t.kind)}</span>
            {t.stats && (t.stats.depth !== undefined || t.stats.consumers !== undefined || t.stats.lag !== undefined) && <QueueNumbers stats={t.stats} />}
          </span>
        ))}
        <span className="ml-auto flex items-center gap-1.5">
          {plugin.choice ? (
            <>
              <span>next call via</span>
              <TransportBadge transport={plugin.choice.kind} />
              <Badge tone="accent" title={REASON_LABELS[plugin.choice.reason]?.title}>
                {REASON_LABELS[plugin.choice.reason]?.label ?? plugin.choice.reason}
              </Badge>
            </>
          ) : (
            plugin.choiceError && (
              <span className="text-rd" title={plugin.choiceError}>
                no transport: {plugin.choiceError.replace(/^Plugin "[^"]*"(:| is)?\s*/, '')}
              </span>
            )
          )}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span>Policy</span>
        <div className="flex rounded-lg border border-hair bg-wl p-0.5" role="radiogroup" aria-label="Transport policy">
          {(['auto', 'pinned', 'allowed'] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              disabled={busy}
              role="radio"
              aria-checked={mode === m}
              className={cn('rounded-md border px-2.5 py-px text-[12px] transition-colors duration-[120ms]', mode === m ? 'border-bd bg-sf font-semibold text-t1' : 'border-transparent text-t3 hover:text-t1')}
            >
              {m === 'auto' ? 'Auto' : m === 'pinned' ? 'Pinned' : 'Allowed'}
            </button>
          ))}
        </div>
        {mode === 'pinned' && (
          <Select value={policy.pinned ?? kinds[0] ?? ''} disabled={busy} onChange={(e) => void save({ mode: 'pinned', pinned: e.target.value, objective: policy.objective })} aria-label="Pinned transport" className="h-7 w-auto py-0 text-[12px]">
            {[...new Set([...kinds, ...(policy.pinned ? [policy.pinned] : [])])].map((kind) => (
              <option key={kind} value={kind}>
                {transportLabel(kind)}
              </option>
            ))}
          </Select>
        )}
        {mode === 'allowed' &&
          [...new Set([...kinds, ...(policy.allowed ?? [])])].map((kind) => {
            const on = (policy.allowed ?? kinds).includes(kind);
            return (
              <button
                key={kind}
                onClick={() => toggleAllowed(kind)}
                disabled={busy}
                aria-pressed={on}
                className={cn('rounded-md border px-2 py-px font-mono text-[11px] transition-colors duration-[120ms]', on ? 'border-acbd bg-acdim text-ac' : 'border-hair text-t3 line-through hover:text-t1')}
              >
                {transportLabel(kind)}
              </button>
            );
          })}
        {mode !== 'pinned' && (
          <span className="ml-auto flex items-center gap-1.5">
            <span>objective</span>
            <Select value={policy.objective} disabled={busy} onChange={(e) => void save({ ...policy, objective: e.target.value as TransportObjective })} aria-label="Auto objective" className="h-7 w-auto py-0 text-[12px]">
              {OBJECTIVES.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * MCP (docs/transports.md "Expose to agents"): the switch that puts the plugin's tools behind the gateway and its
 * /api/mcp/plugins/<id> endpoint, the tool count, and a fold-out list of the tools (loaded from GET /api/mcp/tools).
 */
function McpExposure({ plugin, onChange }: { plugin: PluginSummary; onChange: (plugins: PluginSummary[]) => void }) {
  const mcp = plugin.mcp;
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState<McpToolView[] | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();

  useEffect(() => {
    if (!open || tools || !mcp?.exposed) return;
    api<McpToolsResponse>('/api/mcp/tools')
      .then((r) => setTools(r.tools.filter((t) => t.pluginId === plugin.id)))
      .catch((e: Error) => setLoadError(e.message));
  }, [open, tools, mcp?.exposed, plugin.id]);

  if (!mcp) return null;
  const toggle = async (exposed: boolean) => {
    setBusy(true);
    try {
      onChange((await api<{ plugins: PluginSummary[] }>(`/api/plugins/${plugin.id}`, { method: 'PATCH', json: { mcp: { exposed } } })).plugins);
      toast(`${plugin.info.name}: ${exposed ? 'exposed to agents' : 'hidden from agents'}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="border-t border-hair px-4 py-2.5 text-[12px] text-t3">
      <div className="flex flex-wrap items-center gap-2">
        <Switch checked={mcp.exposed} disabled={busy} onChange={(v) => void toggle(v)} label={`Expose ${plugin.info.name} to agents`} />
        <span className="text-t2">Expose to agents</span>
        <span title={mcp.exposed ? `MCP endpoint ${mcp.path}; registered in the MCP gateway` : 'Not served to agents: no gateway target, the endpoint answers 404'}>
          {mcp.exposed ? (
            <>
              <span className="font-mono text-[11px] text-t2">{mcp.path}</span> · {mcp.tools} MCP tool{mcp.tools === 1 ? '' : 's'}
            </>
          ) : (
            <>{mcp.tools} MCP tool{mcp.tools === 1 ? '' : 's'}, hidden</>
          )}
        </span>
        {mcp.exposed && mcp.tools > 0 && (
          <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="ml-auto flex items-center gap-1 text-t3 transition-colors duration-[120ms] hover:text-t1">
            MCP tools <ChevronDown className={cn('size-3.5 transition-transform duration-[120ms]', open && 'rotate-180')} strokeWidth={1.7} />
          </button>
        )}
      </div>
      {open && mcp.exposed && (
        <div className="mt-2 space-y-1">
          {loadError && <div className="text-rd">{loadError}</div>}
          {!tools && !loadError && <div>Loading tools…</div>}
          {tools?.map((tool) => (
            <div key={tool.name} className={cn('flex flex-wrap items-baseline gap-x-2 gap-y-0.5', tool.blocked && 'opacity-60')} title={tool.description}>
              <span className="font-mono text-[12px] text-t1">{tool.name}</span>
              <span className="font-mono text-[11px] text-t3" title="The name on the gateway's shared endpoint">
                {tool.gatewayName}
              </span>
              <span className="truncate text-t2">{tool.title}</span>
              <span className="ml-auto flex shrink-0 gap-1">
                {tool.annotations.readOnlyHint && <Badge tone="muted">read-only</Badge>}
                {tool.annotations.destructiveHint && <Badge tone="muted">destructive</Badge>}
                {tool.annotations.idempotentHint && !tool.annotations.readOnlyHint && <Badge tone="muted">idempotent</Badge>}
                {tool.credentials.length > 0 && <Badge tone="muted" title={`Needs a credential: ${tool.credentials.join(', ')}`}>credential</Badge>}
                {tool.blocked && <Badge tone="muted" title={tool.blocked}>blocked</Badge>}
              </span>
            </div>
          ))}
          {tools && !tools.length && <div>No tools: no action node of this plugin is usable as a tool.</div>}
        </div>
      )}
    </div>
  );
}

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
  // Discovery sources besides the first one (a plugin can be announced and discovered), and Kubernetes namespaces.
  const otherSources = [...new Set(plugin.endpoints.map((e) => e.source))].filter((source) => source !== plugin.source);
  const namespaces = [...new Set(plugin.endpoints.flatMap((e) => (e.origin ? [e.origin.namespace] : [])))];

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
            {otherSources.map((source) => (
              <Badge key={source} tone="muted">
                {source}
              </Badge>
            ))}
            {namespaces.map((namespace) => (
              <Badge key={namespace} tone="muted" title="Kubernetes namespace" className="font-mono font-medium">
                ns/{namespace}
              </Badge>
            ))}
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
                {endpoint.origin && (
                  <span className="shrink-0 truncate font-mono text-[11px] text-t3" title={`Kubernetes Service ${endpoint.origin.service} in namespace ${endpoint.origin.namespace}`}>
                    {endpoint.origin.namespace}/{endpoint.origin.service}
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-3">
                  <QueueNumbers stats={endpoint.queue} />
                  {endpoint.latencyMs !== undefined && <span className="font-mono text-[11px] tabular-nums text-t3">{endpoint.latencyMs}ms</span>}
                  {endpoint.source === 'announce' && endpoint.status === 'online' ? <LeaseBar expiresAt={endpoint.leaseExpiresAt} /> : <span className="text-[12px] text-t3">{timeAgo(endpoint.lastSeen)}</span>}
                </span>
              </div>
            );
          })
        )}
      </div>

      {!builtin && plugin.transports && plugin.transports.length > 0 && <TransportPolicyPicker plugin={plugin} onChange={onChange} />}

      <McpExposure plugin={plugin} onChange={onChange} />

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
