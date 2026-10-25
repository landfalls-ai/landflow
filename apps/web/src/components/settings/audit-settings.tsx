'use client';
/**
 * Settings → Audit log: who did what, when and from where. The log with filters (actor, action, target, outcome,
 * time, text), newest first and paged by cursor, with CSV and JSON export of the same filter; how long events are
 * kept and whether credential use in runs is recorded; and SIEM streaming: syslog (RFC 5424 over UDP, TCP or TLS),
 * HTTP JSON lines (signed, or Datadog and Elasticsearch presets) and Splunk HEC, each with "Send test event" and
 * its outbox. Owners and admins only (the `audit:read` action).
 */
import { useCallback, useEffect, useState } from 'react';
import { Check, Download, Pencil, Plus, RotateCw, Search, Send, Trash2, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { can } from '@/lib/shared/auth';
import {
  AUDIT_ACTIONS,
  AUDIT_DESTINATION_KINDS,
  type AuditDelivery,
  type AuditDestination,
  type AuditDestinationConfig,
  type AuditDestinationKind,
  type AuditEvent,
  type AuditOutcome,
  type AuditPage,
  type AuditSettingsView,
} from '@/lib/shared/audit';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Badge, type Tone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, SectionLabel, Select, Switch, Textarea } from '@/components/ui/inputs';

const OUTCOME_TONE: Record<AuditOutcome, Tone> = { success: 'success', failure: 'danger', denied: 'warning' };
const RETENTION = [
  { value: 30, label: '30 days' },
  { value: 90, label: '90 days' },
  { value: 180, label: '6 months' },
  { value: 365, label: '1 year' },
  { value: 730, label: '2 years' },
  { value: 2555, label: '7 years' },
  { value: 0, label: 'Forever' },
];
const CATEGORIES = [...new Set(Object.keys(AUDIT_ACTIONS).map((a) => a.split('.')[0]))];

interface Filters {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  outcome: '' | AuditOutcome;
  from: string;
  to: string;
  q: string;
}
const NO_FILTERS: Filters = { actor: '', action: '', targetType: '', targetId: '', outcome: '', from: '', to: '', q: '' };

function query(filters: Filters, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, key === 'to' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999Z` : value);
  for (const [key, value] of Object.entries(extra)) params.set(key, value);
  return params.toString();
}

function actorLabel(event: AuditEvent): string {
  const { actor } = event;
  if (actor.type === 'system') return 'Landflow';
  if (actor.type === 'anonymous') return actor.email ? `${actor.email} (not signed in)` : 'Not signed in';
  return actor.name || actor.email || actor.id || 'Unknown';
}

function EventRow({ event, onFilter }: { event: AuditEvent; onFilter: (patch: Partial<Filters>) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="cursor-pointer border-b border-hair align-top hover:bg-acdim" onClick={() => setOpen((o) => !o)}>
        <td className="whitespace-nowrap px-3 py-2 text-[12px] text-t3" title={new Date(event.at).toLocaleString()}>
          {timeAgo(event.at)}
        </td>
        <td className="max-w-[160px] truncate px-3 py-2 text-[12px] text-t1" title={event.actor.email}>
          {actorLabel(event)}
          {event.apiKeyId && <span className="ml-1 text-[11px] text-t3">· key</span>}
        </td>
        <td className="px-3 py-2 text-[12px]">
          <div className="text-t1">{event.summary}</div>
          <div className="font-mono text-[11px] text-t3">{event.action}</div>
        </td>
        <td className="px-3 py-2">
          <Badge tone={OUTCOME_TONE[event.outcome]}>{event.outcome}</Badge>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-hair bg-sf2">
          <td colSpan={4} className="px-3 py-2.5">
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-x-3 gap-y-1 text-[12px]">
              <dt className="text-t3">When</dt>
              <dd className="text-t1">{new Date(event.at).toLocaleString()}</dd>
              <dt className="text-t3">Actor</dt>
              <dd className="text-t1">
                <button type="button" className="hover:text-ac" onClick={() => event.actor.id && onFilter({ actor: event.actor.id })}>
                  {actorLabel(event)} {event.actor.email && <span className="text-t3">{event.actor.email}</span>} <span className="text-t3">({event.actor.type})</span>
                </button>
              </dd>
              {event.apiKeyId && (
                <>
                  <dt className="text-t3">API key</dt>
                  <dd className="font-mono text-t1">{event.apiKeyId}</dd>
                </>
              )}
              {event.target && (
                <>
                  <dt className="text-t3">Target</dt>
                  <dd className="text-t1">
                    <button type="button" className="hover:text-ac" onClick={() => onFilter({ targetType: event.target!.type, targetId: event.target!.id ?? '' })}>
                      {event.target.type}
                      {event.target.name && ` “${event.target.name}”`} {event.target.id && <span className="font-mono text-t3">{event.target.id}</span>}
                    </button>
                  </dd>
                </>
              )}
              {(event.method || event.route) && (
                <>
                  <dt className="text-t3">Request</dt>
                  <dd className="font-mono text-t1">
                    {event.method} {event.route} {event.status && <span className="text-t3">→ {event.status}</span>}
                  </dd>
                </>
              )}
              {event.ip && (
                <>
                  <dt className="text-t3">IP</dt>
                  <dd className="font-mono text-t1">{event.ip}</dd>
                </>
              )}
              {event.userAgent && (
                <>
                  <dt className="text-t3">User agent</dt>
                  <dd className="truncate text-t1" title={event.userAgent}>
                    {event.userAgent}
                  </dd>
                </>
              )}
              {event.requestId && (
                <>
                  <dt className="text-t3">Request ID</dt>
                  <dd className="font-mono text-t1">{event.requestId}</dd>
                </>
              )}
              {event.details &&
                Object.entries(event.details).map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="truncate text-t3">{key}</dt>
                    <dd className="break-all font-mono text-t1">{Array.isArray(value) ? value.join(', ') : String(value)}</dd>
                  </div>
                ))}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}

function AuditLog() {
  const [draft, setDraft] = useState<Filters>(NO_FILTERS);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [events, setEvents] = useState<AuditEvent[]>();
  const [cursor, setCursor] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (next: Filters, after?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const page = await api<AuditPage>(`/api/audit?${query(next, { limit: '50', ...(after && { cursor: after }) })}`);
      setEvents((current) => (after ? [...(current ?? []), ...page.events] : page.events));
      setCursor(page.nextCursor);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => void load(filters), [filters, load]);

  const apply = (patch: Partial<Filters> = {}) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setFilters(next);
  };
  const set = (patch: Partial<Filters>) => setDraft((d) => ({ ...d, ...patch }));
  const filtered = Object.values(filters).some(Boolean);

  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-3">
        <SectionLabel className="flex-1">Events</SectionLabel>
        <a href={`/api/audit/export?${query(filters, { format: 'csv' })}`} download>
          <Button size="sm" tabIndex={-1}>
            <Download className="size-3.5" /> CSV
          </Button>
        </a>
        <a href={`/api/audit/export?${query(filters, { format: 'json' })}`} download>
          <Button size="sm" tabIndex={-1}>
            <Download className="size-3.5" /> JSON
          </Button>
        </a>
      </div>
      <Card className="space-y-2.5 p-3">
        <form
          className="grid grid-cols-2 gap-2 sm:grid-cols-4"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          <div className="relative col-span-2">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
            <Input value={draft.q} onChange={(e) => set({ q: e.target.value })} placeholder="Search summaries and names" className="pl-8" aria-label="Search" />
          </div>
          <Input value={draft.actor} onChange={(e) => set({ actor: e.target.value })} placeholder="Actor: name, email or id" aria-label="Actor" />
          <Select value={draft.action} onChange={(e) => apply({ action: e.target.value })} aria-label="Action">
            <option value="">All actions</option>
            {CATEGORIES.map((category) => (
              <optgroup key={category} label={category}>
                <option value={`${category}.*`}>All {category}</option>
                {Object.entries(AUDIT_ACTIONS)
                  .filter(([action]) => action.startsWith(`${category}.`))
                  .map(([action, label]) => (
                    <option key={action} value={action}>
                      {label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </Select>
          <Input value={draft.targetType} onChange={(e) => set({ targetType: e.target.value })} placeholder="Target type: workflow, user…" aria-label="Target type" />
          <Input value={draft.targetId} onChange={(e) => set({ targetId: e.target.value })} placeholder="Target id" aria-label="Target id" />
          <Select value={draft.outcome} onChange={(e) => apply({ outcome: e.target.value as Filters['outcome'] })} aria-label="Outcome">
            <option value="">Any outcome</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
            <option value="denied">Denied</option>
          </Select>
          <div className="flex items-center gap-1.5">
            <Input type="date" value={draft.from} onChange={(e) => apply({ from: e.target.value })} aria-label="From" title="From" />
            <Input type="date" value={draft.to} onChange={(e) => apply({ to: e.target.value })} aria-label="To" title="To" />
          </div>
          <div className="col-span-2 flex items-center gap-2 sm:col-span-4">
            <Button size="sm" variant="primary" type="submit">
              Apply
            </Button>
            {filtered && (
              <Button
                size="sm"
                variant="ghost"
                type="button"
                onClick={() => {
                  setDraft(NO_FILTERS);
                  setFilters(NO_FILTERS);
                }}
              >
                <X className="size-3.5" /> Clear filters
              </Button>
            )}
          </div>
        </form>
      </Card>
      {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
      <Card className="overflow-hidden p-0">
        {events?.length ? (
          <table className="w-full table-fixed">
            <colgroup>
              <col className="w-[96px]" />
              <col className="w-[160px]" />
              <col />
              <col className="w-[90px]" />
            </colgroup>
            <thead>
              <tr className="border-b border-hair text-left text-[11px] uppercase tracking-wide text-t3">
                <th className="px-3 py-2 font-semibold">When</th>
                <th className="px-3 py-2 font-semibold">Who</th>
                <th className="px-3 py-2 font-semibold">What</th>
                <th className="px-3 py-2 font-semibold">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <EventRow key={event.id} event={event} onFilter={apply} />
              ))}
            </tbody>
          </table>
        ) : (
          <div className="py-6">{events ? <EmptyState title={filtered ? 'No event matches' : 'No events yet'} hint={filtered ? 'Try fewer filters.' : 'Sign-ins, changes and runs that use credentials show up here.'} /> : <div className="px-4 text-[13px] text-t3">Loading…</div>}</div>
        )}
        {cursor && (
          <div className="flex justify-center border-t border-hair py-2.5">
            <Button size="sm" variant="ghost" loading={loading} onClick={() => void load(filters, cursor)}>
              Load older events
            </Button>
          </div>
        )}
      </Card>
    </section>
  );
}

function DeliveryLine({ destination }: { destination: AuditDestination }) {
  const delivery: AuditDelivery | undefined = destination.lastDelivery;
  return (
    <div className="flex flex-wrap items-center gap-x-3 text-[11px]">
      {delivery ? (
        <span className={cn('inline-flex min-w-0 items-center gap-1', delivery.ok ? 'text-gn' : 'text-rd')} title={delivery.message}>
          {delivery.ok ? <Check className="size-3 shrink-0" /> : <TriangleAlert className="size-3 shrink-0" />}
          <span className="truncate">
            {delivery.ok ? 'Delivered' : 'Failed'} {timeAgo(delivery.at)}
            {!delivery.ok && delivery.message ? ` — ${delivery.message}` : ''}
          </span>
        </span>
      ) : (
        <span className="text-t3">Nothing sent yet</span>
      )}
      {destination.pending > 0 && (
        <span className="text-warn">
          {destination.pending.toLocaleString()} waiting{destination.oldestPendingAt ? ` since ${timeAgo(destination.oldestPendingAt)}` : ''}
        </span>
      )}
    </div>
  );
}

function destinationTarget(d: AuditDestination): string {
  const c = d.config;
  if (d.kind === 'syslog') return `${(c.protocol ?? 'udp').toUpperCase()} ${c.host ?? '?'}:${c.port ?? (c.protocol === 'tls' ? 6514 : 514)}`;
  if (d.kind === 'splunk') return `${c.url ?? ''}${c.index ? ` · index ${c.index}` : ''}`;
  const preset = c.preset === 'datadog' ? 'Datadog · ' : c.preset === 'elastic' ? 'Elasticsearch · ' : '';
  return `${preset}${c.url ?? ''}${(c.preset ?? 'generic') === 'generic' && d.secretsSet.includes('secret') ? ' · signed' : ''}`;
}

function DestinationEditor({ initial, onSaved, onCancel }: { initial?: AuditDestination; onSaved: (destination: AuditDestination) => void; onCancel: () => void }) {
  const [kind, setKind] = useState<AuditDestinationKind>(initial?.kind ?? 'syslog');
  const [name, setName] = useState(initial?.name ?? '');
  const [config, setConfig] = useState<AuditDestinationConfig>(initial?.config ?? { protocol: 'tcp', port: 514 });
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const set = (next: Partial<AuditDestinationConfig>) => setConfig((c) => ({ ...c, ...next }));
  const saved = (field: string) => Boolean(initial?.secretsSet.includes(field));
  const secretHint = (field: string, fallback: string) => (saved(field) ? 'Saved — leave empty to keep it' : fallback);
  const preset = config.preset ?? 'generic';

  const choose = (next: AuditDestinationKind) => {
    setKind(next);
    setConfig(next === 'syslog' ? { protocol: 'tcp', port: 514 } : next === 'http' ? { preset: 'generic' } : {});
  };

  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    // Empty strings and NaN ports would fail validation; drop them (empty secrets keep their saved value).
    const clean = Object.fromEntries(Object.entries(config).filter(([, v]) => v !== '' && v !== undefined && !(typeof v === 'number' && Number.isNaN(v))));
    try {
      const { destination } = initial
        ? await api<{ destination: AuditDestination }>(`/api/settings/audit/destinations/${initial.id}`, { method: 'PATCH', json: { name, config: clean } })
        : await api<{ destination: AuditDestination }>('/api/settings/audit/destinations', { method: 'POST', json: { name: name || AUDIT_DESTINATION_KINDS.find((k) => k.id === kind)!.label, kind, config: clean } });
      toast.success(initial ? `Saved ${destination.name}` : 'Destination added — send a test event to check it');
      onSaved(destination);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-b border-hair bg-sf2 px-4 py-3.5 last:border-b-0 animate-fade-up">
      {!initial && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Destination type">
          {AUDIT_DESTINATION_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={kind === k.id}
              title={k.hint}
              onClick={() => choose(k.id)}
              className={cn('flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors', kind === k.id ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
            >
              {k.label}
            </button>
          ))}
        </div>
      )}
      <div>
        <FieldLabel>Name</FieldLabel>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'syslog' ? 'rsyslog on siem-01' : kind === 'splunk' ? 'Splunk' : 'Log pipeline'} autoFocus />
      </div>
      {kind === 'syslog' && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_100px_110px] gap-3">
            <div>
              <FieldLabel>Host</FieldLabel>
              <Input value={config.host ?? ''} onChange={(e) => set({ host: e.target.value })} placeholder="siem.internal" />
            </div>
            <div>
              <FieldLabel>Port</FieldLabel>
              <Input type="number" value={config.port ?? ''} onChange={(e) => set({ port: e.target.value ? Number(e.target.value) : undefined })} placeholder={config.protocol === 'tls' ? '6514' : '514'} />
            </div>
            <div>
              <FieldLabel>Protocol</FieldLabel>
              <Select value={config.protocol ?? 'udp'} onChange={(e) => set({ protocol: e.target.value as AuditDestinationConfig['protocol'], ...(e.target.value === 'tls' && (config.port ?? 514) === 514 && { port: 6514 }) })}>
                <option value="udp">UDP</option>
                <option value="tcp">TCP</option>
                <option value="tls">TLS</option>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <FieldLabel>Facility</FieldLabel>
              <Input type="number" min={0} max={23} value={config.facility ?? ''} onChange={(e) => set({ facility: e.target.value ? Number(e.target.value) : undefined })} placeholder="13 (log audit)" />
            </div>
            <div>
              <FieldLabel>App name</FieldLabel>
              <Input value={config.appName ?? ''} onChange={(e) => set({ appName: e.target.value })} placeholder="landflow" />
            </div>
            {config.protocol !== 'udp' && config.protocol !== undefined && (
              <div>
                <FieldLabel>Framing</FieldLabel>
                <Select value={config.framing ?? 'octet-counting'} onChange={(e) => set({ framing: e.target.value as AuditDestinationConfig['framing'] })}>
                  <option value="octet-counting">Octet counting</option>
                  <option value="newline">Newline</option>
                </Select>
              </div>
            )}
          </div>
          {config.protocol === 'tls' && (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-[12px] text-t1">
                <Switch checked={config.rejectUnauthorized !== false} onChange={(value) => set({ rejectUnauthorized: value })} label="Check the server’s certificate" /> Check the server’s certificate
              </label>
              <div>
                <FieldLabel>CA certificate (PEM, optional)</FieldLabel>
                <Textarea rows={3} value={config.ca ?? ''} onChange={(e) => set({ ca: e.target.value })} placeholder="-----BEGIN CERTIFICATE-----" className="font-mono text-[11px]" />
              </div>
            </div>
          )}
          <p className="text-[11px] leading-snug text-t3">
            RFC 5424 messages with the event as structured data (<code className="font-mono">[landflow@32473 …]</code>) and the full JSON as the message. UDP drops what doesn’t fit in one datagram; prefer TCP or TLS.
          </p>
        </>
      )}
      {kind === 'http' && (
        <>
          <div className="flex gap-0.5 rounded-[10px] border border-hair bg-wl p-0.5" role="radiogroup" aria-label="Preset">
            {(
              [
                { id: 'generic', label: 'JSON lines' },
                { id: 'datadog', label: 'Datadog' },
                { id: 'elastic', label: 'Elasticsearch' },
              ] as const
            ).map((p) => (
              <button
                key={p.id}
                type="button"
                role="radio"
                aria-checked={preset === p.id}
                onClick={() => set({ preset: p.id, ...(p.id === 'datadog' && !config.url && { url: 'https://http-intake.logs.datadoghq.com/api/v2/logs' }) })}
                className={cn('h-7 flex-1 rounded-[8px] text-[12px] transition-colors', preset === p.id ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:text-ac')}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div>
            <FieldLabel>{preset === 'elastic' ? 'Elasticsearch URL' : 'URL'}</FieldLabel>
            <Input value={config.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder={preset === 'elastic' ? 'https://elastic.internal:9200' : preset === 'datadog' ? 'https://http-intake.logs.datadoghq.eu/api/v2/logs' : 'https://logs.example.com/landflow'} />
          </div>
          {preset === 'generic' && (
            <div>
              <FieldLabel>Signing secret (optional)</FieldLabel>
              <Input type="password" autoComplete="off" value={config.secret ?? ''} onChange={(e) => set({ secret: e.target.value })} placeholder={secretHint('secret', 'Any long random string')} />
              <p className="mt-1 text-[11px] leading-snug text-t3">
                One event per line (<code className="font-mono">application/x-ndjson</code>). Each POST carries <code className="font-mono">X-Landflow-Timestamp</code> and{' '}
                <code className="font-mono">X-Landflow-Signature: sha256=…</code>, the HMAC-SHA256 of <code className="font-mono">{'<timestamp>.<body>'}</code>.
              </p>
            </div>
          )}
          {preset !== 'generic' && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel>{preset === 'datadog' ? 'API key' : 'API key (optional)'}</FieldLabel>
                <Input type="password" autoComplete="off" value={config.apiKey ?? ''} onChange={(e) => set({ apiKey: e.target.value })} placeholder={secretHint('apiKey', preset === 'datadog' ? 'DD-API-KEY' : 'Base64 id:key')} />
              </div>
              {preset === 'datadog' ? (
                <div>
                  <FieldLabel>Tags (optional)</FieldLabel>
                  <Input value={config.tags ?? ''} onChange={(e) => set({ tags: e.target.value })} placeholder="env:prod,team:platform" />
                </div>
              ) : (
                <div>
                  <FieldLabel>Index or data stream</FieldLabel>
                  <Input value={config.index ?? ''} onChange={(e) => set({ index: e.target.value })} placeholder="logs-landflow.audit-default" />
                </div>
              )}
            </div>
          )}
        </>
      )}
      {kind === 'splunk' && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <FieldLabel>HEC URL</FieldLabel>
              <Input value={config.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://splunk.internal:8088" />
            </div>
            <div>
              <FieldLabel>HEC token</FieldLabel>
              <Input type="password" autoComplete="off" value={config.token ?? ''} onChange={(e) => set({ token: e.target.value })} placeholder={secretHint('token', '00000000-0000-…')} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <FieldLabel>Index (optional)</FieldLabel>
              <Input value={config.index ?? ''} onChange={(e) => set({ index: e.target.value })} placeholder="main" />
            </div>
            <div>
              <FieldLabel>Source</FieldLabel>
              <Input value={config.source ?? ''} onChange={(e) => set({ source: e.target.value })} placeholder="landflow" />
            </div>
            <div>
              <FieldLabel>Sourcetype</FieldLabel>
              <Input value={config.sourcetype ?? ''} onChange={(e) => set({ sourcetype: e.target.value })} placeholder="landflow:audit" />
            </div>
          </div>
        </>
      )}
      {problem && <div className="text-[12px] text-rd">{problem}</div>}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
          {initial ? 'Save destination' : 'Add destination'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AuditSettings() {
  const viewer = useViewer();
  const admin = can(viewer, 'settings:manage');
  const [view, setView] = useState<AuditSettingsView>();
  const [error, setError] = useState<string>();
  const [edit, setEdit] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string>();
  const [busy, setBusy] = useState<string>();

  useEffect(() => {
    api<AuditSettingsView>('/api/settings/audit').then(setView, (e: Error) => setError(e.message));
  }, []);

  const replace = (destination: AuditDestination) =>
    setView((v) => v && { ...v, destinations: v.destinations.some((d) => d.id === destination.id) ? v.destinations.map((d) => (d.id === destination.id ? destination : d)) : [...v.destinations, destination] });

  const patchSettings = async (patch: Partial<AuditSettingsView['settings']>) => {
    try {
      setView(await api<AuditSettingsView>('/api/settings/audit', { method: 'PATCH', json: patch }));
      toast.success('Saved');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const act = async (destination: AuditDestination, what: 'test' | 'retry' | 'enable' | 'disable' | 'delete') => {
    setBusy(`${what}:${destination.id}`);
    try {
      if (what === 'test') {
        const result = await api<{ ok: boolean; message?: string; destination?: AuditDestination }>(`/api/settings/audit/destinations/${destination.id}/test`, { method: 'POST' });
        if (result.destination) replace(result.destination);
        if (result.ok) toast.success(`Test event delivered to ${destination.name}`);
        else toast.error(`Test event failed: ${result.message ?? 'unknown error'}`);
      } else if (what === 'retry') {
        const result = await api<{ queued: number; delivered: number; destination?: AuditDestination }>(`/api/settings/audit/destinations/${destination.id}/retry`, { method: 'POST' });
        if (result.destination) replace(result.destination);
        toast.success(`Retried ${result.queued.toLocaleString()} waiting events`);
      } else if (what === 'delete') {
        await api(`/api/settings/audit/destinations/${destination.id}`, { method: 'DELETE' });
        setView((v) => v && { ...v, destinations: v.destinations.filter((d) => d.id !== destination.id) });
        setConfirm(undefined);
        toast.success(`Deleted ${destination.name}`);
      } else {
        const { destination: next } = await api<{ destination: AuditDestination }>(`/api/settings/audit/destinations/${destination.id}`, { method: 'PATCH', json: { enabled: what === 'enable' } });
        replace(next);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (error) return <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;

  return (
    <div className="space-y-6">
      <p className="text-[13px] text-t2">
        Who did what, when and from where: sign-ins, user and role changes, API keys, workflow changes and publishes, credentials (and which runs used them — ids only, never values), settings,
        stopped and deleted executions, Git push and pull, plugins. Every other change through the API is recorded too. Events can also stream to your SIEM.
      </p>

      <AuditLog />

      {view && (
        <section className="space-y-2.5">
          <SectionLabel>Retention</SectionLabel>
          <Card className="space-y-3 p-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center">
              <FieldLabel className="mb-0">Keep events for</FieldLabel>
              <Select value={String(view.settings.retentionDays)} onChange={(e) => void patchSettings({ retentionDays: Number(e.target.value) })} disabled={!admin} className="max-w-[200px]">
                {RETENTION.some((r) => r.value === view.settings.retentionDays) ? null : <option value={view.settings.retentionDays}>{view.settings.retentionDays} days</option>}
                {RETENTION.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex items-center gap-2 text-[13px] text-t1">
              <Switch checked={view.settings.credentialUse} onChange={(value) => void patchSettings({ credentialUse: value })} disabled={!admin} label="Record which credentials each run uses" />
              Record which credentials each run uses <span className="text-[12px] text-t3">(credential and node ids and names, never values)</span>
            </div>
            <div className="space-y-0.5 text-[12px] text-t3">
              <div>
                {view.stored.toLocaleString()} events stored. Separate from execution retention (Settings → General); events still waiting for a SIEM destination are kept until delivered.
              </div>
              <div>
                {view.otlp.enabled ? (
                  <span>
                    Also sent as OpenTelemetry log records to <code className="font-mono">{view.otlp.endpoint}</code>.
                  </span>
                ) : (
                  <span>
                    Set <code className="font-mono">OTEL_EXPORTER_OTLP_ENDPOINT</code> (or <code className="font-mono">OTEL_EXPORTER_OTLP_LOGS_ENDPOINT</code>) to also send events as OpenTelemetry log records.
                  </span>
                )}
              </div>
            </div>
          </Card>
        </section>
      )}

      {view && (
        <section className="space-y-2.5">
          <div className="flex items-center gap-3">
            <SectionLabel className="flex-1">SIEM streaming</SectionLabel>
            {admin && (
              <Button size="sm" variant="primary" onClick={() => setEdit('new')} disabled={edit === 'new'}>
                <Plus className="size-3.5" /> Add destination
              </Button>
            )}
          </div>
          <Card className="overflow-hidden p-0">
            {edit === 'new' && (
              <DestinationEditor
                onSaved={(d) => {
                  replace(d);
                  setEdit(null);
                }}
                onCancel={() => setEdit(null)}
              />
            )}
            {view.destinations.map((destination) =>
              edit === destination.id ? (
                <DestinationEditor
                  key={destination.id}
                  initial={destination}
                  onSaved={(d) => {
                    replace(d);
                    setEdit(null);
                  }}
                  onCancel={() => setEdit(null)}
                />
              ) : (
                <div key={destination.id} className="flex items-center gap-3 border-b border-hair px-4 py-3 last:border-b-0">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-semibold text-t1">{destination.name}</span>
                      <Badge tone="muted">{AUDIT_DESTINATION_KINDS.find((k) => k.id === destination.kind)?.label}</Badge>
                      {!destination.enabled && <Badge tone="neutral">Paused</Badge>}
                    </div>
                    <div className="truncate text-[12px] text-t3">{destinationTarget(destination)}</div>
                    <DeliveryLine destination={destination} />
                  </div>
                  {admin &&
                    (confirm === destination.id ? (
                      <div className="flex items-center gap-1.5 text-[12px] text-t2">
                        {destination.pending ? `Delete and drop ${destination.pending} waiting?` : 'Delete?'}
                        <Button size="sm" variant="danger" onClick={() => void act(destination, 'delete')} loading={busy === `delete:${destination.id}`}>
                          Delete
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(undefined)} aria-label="Keep it">
                          <X className="size-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <span className="mr-1" title={destination.enabled ? 'Sending — switch off to pause (events keep queueing)' : 'Paused — events keep queueing'}>
                          <Switch checked={destination.enabled} onChange={(value) => void act(destination, value ? 'enable' : 'disable')} label={`Send to ${destination.name}`} />
                        </span>
                        <Button size="sm" onClick={() => void act(destination, 'test')} loading={busy === `test:${destination.id}`} title="Send one test event now">
                          <Send className="size-3.5" /> Send test event
                        </Button>
                        {destination.pending > 0 && (
                          <Button size="icon-sm" variant="ghost" onClick={() => void act(destination, 'retry')} loading={busy === `retry:${destination.id}`} aria-label="Retry now" title="Retry the waiting events now">
                            <RotateCw className="size-3.5" />
                          </Button>
                        )}
                        <Button size="icon-sm" variant="ghost" onClick={() => setEdit(destination.id)} aria-label={`Edit ${destination.name}`}>
                          <Pencil className="size-3.5" />
                        </Button>
                        <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(destination.id)} aria-label={`Delete ${destination.name}`}>
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    ))}
                </div>
              ),
            )}
            {!view.destinations.length && edit !== 'new' && (
              <div className="py-6">
                <EmptyState title="No destinations yet" hint="Syslog, an HTTP endpoint (Datadog, Elasticsearch or your own) or Splunk HEC. Events queue durably and retry with backoff until delivered." />
              </div>
            )}
          </Card>
        </section>
      )}
    </div>
  );
}
