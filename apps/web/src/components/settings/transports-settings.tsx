'use client';
/**
 * Settings → Transports (owners and admins; docs/transports.md): the transport kinds this host knows (direct HTTP and
 * gRPC, and the broker kinds with or without a driver), the broker connections with add/edit/delete and Test, their
 * health and which plugins are reached through each. Connections from `LANDFLOW_TRANSPORT_<KIND>_URL` are listed
 * read-only. Secret fields are stored encrypted like credentials and never sent back.
 */
import { useEffect, useState } from 'react';
import { Network, Pencil, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { ConnectionField, TransportConnectionCheck, TransportConnectionView, TransportKindInfo, TransportsResponse } from '@/lib/shared/transports';
import { Card } from '@/components/shell/page-header';
import { Badge, StatusDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FieldLabel, Input, SectionLabel, Select, Switch, Textarea } from '@/components/ui/inputs';

interface Draft {
  /** Undefined: a new connection. */
  editing?: string;
  name: string;
  kind: string;
  enabled: boolean;
  values: Record<string, string | boolean>;
}

const isSecret = (field: ConnectionField) => field.type === 'password';

const draftFor = (kind: TransportKindInfo, taken: string[]): Draft => {
  let name = kind.label;
  for (let n = 2; taken.includes(name); n++) name = `${kind.label} ${n}`;
  return { name, kind: kind.kind, enabled: true, values: {} };
};

const draftOf = (connection: TransportConnectionView): Draft => ({ editing: connection.id, name: connection.name, kind: connection.kind, enabled: connection.enabled, values: { ...connection.config } });

function CheckBadge({ check, installed }: { check?: TransportConnectionCheck; installed: boolean }) {
  if (!installed) return <Badge tone="muted" title="The driver for this kind lands in a later release">no driver yet</Badge>;
  if (!check) return <Badge tone="muted">Not tested</Badge>;
  return (
    <Badge tone={check.ok ? 'success' : 'danger'} title={`${check.message} (${new Date(check.at).toLocaleString()})`}>
      {check.ok ? `Connected${check.latencyMs !== undefined ? ` · ${check.latencyMs} ms` : ''}` : 'Failing'}
    </Badge>
  );
}

function ConnectionForm({ kinds, draft, saved, onChange, onDone }: { kinds: TransportKindInfo[]; draft: Draft; saved?: TransportConnectionView; onChange: (d: Draft) => void; onDone: (view?: TransportConnectionView) => void }) {
  const kind = kinds.find((k) => k.kind === draft.kind) ?? kinds[0]!;
  const brokers = kinds.filter((k) => !k.direct);
  const [busy, setBusy] = useState<'test' | 'save'>();
  const [check, setCheck] = useState<TransportConnectionCheck>();
  const set = (name: string, value: string | boolean) => onChange({ ...draft, values: { ...draft.values, [name]: value } });

  // Secret fields left empty keep the saved value; config fields emptied in the form are dropped.
  const payload = () => {
    const config: Record<string, string | boolean> = {};
    const secrets: Record<string, string | null> = {};
    for (const field of kind.fields) {
      const value = draft.values[field.name];
      if (isSecret(field)) {
        if (typeof value === 'string' && value) secrets[field.name] = value;
      } else if (typeof value === 'boolean') config[field.name] = value;
      else if (typeof value === 'string' && value.trim()) config[field.name] = value.trim();
    }
    return { config, secrets };
  };

  const test = async () => {
    setBusy('test');
    try {
      const result = await api<TransportConnectionCheck>(`/api/transports/connections/${encodeURIComponent(draft.editing ?? 'new')}/test`, { method: 'POST', json: { kind: draft.kind, name: draft.name, ...payload() } });
      setCheck(result);
      if (result.ok) toast.success(result.message);
      else toast.error(result.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const save = async () => {
    setBusy('save');
    try {
      const view = draft.editing
        ? await api<TransportConnectionView>(`/api/transports/connections/${encodeURIComponent(draft.editing)}`, { method: 'PATCH', json: { name: draft.name, enabled: draft.enabled, ...payload() } })
        : await api<TransportConnectionView>('/api/transports/connections', { method: 'POST', json: { name: draft.name, kind: draft.kind, enabled: draft.enabled, ...payload() } });
      toast.success(`Saved ${view.name}`);
      onDone(view);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <SectionLabel>{draft.editing ? `Edit ${saved?.name ?? draft.name}` : 'Add a connection'}</SectionLabel>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => onDone()} aria-label="Close">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>Broker</FieldLabel>
          <Select value={draft.kind} disabled={Boolean(draft.editing)} onChange={(e) => onChange({ ...draftFor(brokers.find((k) => k.kind === e.target.value)!, []), name: draft.name })}>
            {brokers.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
                {k.installed ? '' : ' (no driver yet)'}
              </option>
            ))}
          </Select>
          {!kind.installed && <p className="mt-1 text-[12px] text-t3">No driver for {kind.label} in this host yet: the connection is saved and tested once it lands.</p>}
        </div>
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value })} spellCheck={false} />
          <p className="mt-1 font-mono text-[11px] text-t3">{`${draft.kind}://${draft.editing ?? '<id>'}/<plugin>`}</p>
        </div>
        {kind.fields.map((field) => {
          const value = draft.values[field.name];
          const secretSaved = saved?.secretsSet.includes(field.name);
          const placeholder = isSecret(field) && secretSaved ? '•••••••• (saved; leave empty to keep)' : field.placeholder;
          return (
            <div key={field.name} className={field.type === 'textarea' ? 'sm:col-span-2' : undefined}>
              {field.type === 'boolean' ? (
                <div className="flex items-center gap-2 pt-5">
                  <Switch checked={Boolean(value)} onChange={(v) => set(field.name, v)} label={field.label} />
                  <span className="text-[13px] text-t2">{field.label}</span>
                </div>
              ) : (
                <>
                  <FieldLabel>
                    {field.label}
                    {field.required && !secretSaved ? ' *' : ''}
                  </FieldLabel>
                  {field.type === 'textarea' ? (
                    <Textarea value={String(value ?? '')} onChange={(e) => set(field.name, e.target.value)} placeholder={placeholder} rows={4} spellCheck={false} className="font-mono text-[12px]" />
                  ) : (
                    <Input type={isSecret(field) ? 'password' : 'text'} value={String(value ?? '')} onChange={(e) => set(field.name, e.target.value)} placeholder={placeholder} autoComplete={isSecret(field) ? 'new-password' : 'off'} spellCheck={false} />
                  )}
                </>
              )}
              {field.hint && <p className="mt-1 text-[12px] text-t3">{field.hint}</p>}
            </div>
          );
        })}
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch checked={draft.enabled} onChange={(v) => onChange({ ...draft, enabled: v })} label="Enabled" />
          <span className="text-[13px] text-t2">Enabled (a turned-off connection offers no transport to the plugins on it)</span>
        </div>
      </div>
      {check && <p className={`mt-3 text-[13px] ${check.ok ? 'text-t2' : 'text-rd'}`}>{check.message}</p>}
      <div className="mt-4 flex items-center gap-2">
        <Button onClick={test} loading={busy === 'test'}>
          <RefreshCw className="size-3.5" /> Test connection
        </Button>
        <Button variant="primary" onClick={save} loading={busy === 'save'} disabled={!draft.name.trim()}>
          <Save className="size-3.5" /> Save
        </Button>
      </div>
    </Card>
  );
}

function ConnectionRow({ connection, kinds, onEdit, onChanged, onDeleted }: { connection: TransportConnectionView; kinds: TransportKindInfo[]; onEdit: () => void; onChanged: (v: TransportConnectionView) => void; onDeleted: () => void }) {
  const [busy, setBusy] = useState<'test' | 'toggle' | 'delete'>();
  const kind = kinds.find((k) => k.kind === connection.kind);
  const readOnly = connection.source === 'env';

  const act = async (what: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const test = () =>
    act('test', async () => {
      const check = await api<TransportConnectionCheck>(`/api/transports/connections/${encodeURIComponent(connection.id)}/test`, { method: 'POST' });
      onChanged({ ...connection, lastCheck: check });
      if (check.ok) toast.success(check.message);
      else toast.error(check.message);
    });
  const toggle = (enabled: boolean) => act('toggle', async () => onChanged(await api<TransportConnectionView>(`/api/transports/connections/${encodeURIComponent(connection.id)}`, { method: 'PATCH', json: { enabled } })));
  const remove = () =>
    act('delete', async () => {
      if (!window.confirm(`Delete ${connection.name}? Plugins reached only through it become unreachable.`)) return;
      await api(`/api/transports/connections/${encodeURIComponent(connection.id)}`, { method: 'DELETE' });
      onDeleted();
    });

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <StatusDot status={connection.enabled && connection.lastCheck?.ok ? 'online' : 'offline'} />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-t1">{connection.name}</span>
            <span className="truncate text-[12px] text-t3">{kind?.label ?? connection.kind}</span>
            {readOnly && (
              <Badge tone="muted" title={`LANDFLOW_TRANSPORT_${connection.kind.toUpperCase()}_URL`}>
                environment
              </Badge>
            )}
          </span>
          <span className="block truncate font-mono text-[11px] text-t3" title={String(connection.config.url ?? '')}>
            {connection.kind}://{connection.id} {connection.config.url ? `· ${String(connection.config.url)}` : ''}
          </span>
        </span>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-t3" title={connection.plugins.join(', ') || 'No plugin has an endpoint on this connection yet'}>
            {connection.plugins.length} plugin{connection.plugins.length === 1 ? '' : 's'}
          </span>
          <CheckBadge check={connection.lastCheck} installed={kind?.installed ?? false} />
          {connection.lastCheck && <span className="hidden text-[11px] text-t3 sm:inline">{timeAgo(connection.lastCheck.at)}</span>}
          <Switch checked={connection.enabled} onChange={toggle} disabled={readOnly || busy === 'toggle'} label={`Enable ${connection.name}`} />
          <Button variant="ghost" size="icon-sm" onClick={test} loading={busy === 'test'} aria-label={`Test ${connection.name}`} title="Test the connection">
            <RefreshCw className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} disabled={readOnly} aria-label={`Edit ${connection.name}`}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={remove} disabled={readOnly} loading={busy === 'delete'} aria-label={`Delete ${connection.name}`}>
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </div>
      {connection.plugins.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-5">
          {connection.plugins.map((id) => (
            <Badge key={id} tone="muted" className="font-mono">
              {id}
            </Badge>
          ))}
        </div>
      )}
    </li>
  );
}

/** The kinds this host knows: direct ones always ready, brokers with or without a driver. */
function KindsCard({ kinds, connections }: { kinds: TransportKindInfo[]; connections: TransportConnectionView[] }) {
  return (
    <Card className="px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <Network className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Installed transports</SectionLabel>
      </div>
      <p className="mb-3 text-[12px] text-t3">
        A transport is offered for a plugin when both sides have it: this host has the driver and a healthy connection, and the plugin has a live endpoint on it. Direct transports need no connection; brokers are
        reached through the connections below. Each plugin chooses per call (Auto), or is pinned on the Plugins page.
      </p>
      <ul className="grid gap-2 sm:grid-cols-2">
        {kinds.map((kind) => {
          const count = connections.filter((c) => c.kind === kind.kind).length;
          return (
            <li key={kind.kind} className="flex items-center gap-2 rounded-[10px] border border-hair bg-wl px-3 py-2">
              <StatusDot status={kind.installed ? 'online' : 'offline'} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-t1">{kind.label}</span>
                <span className="block text-[11px] text-t3">
                  {kind.direct ? 'direct · the host connects to the plugin' : kind.installed ? `broker · ${count} connection${count === 1 ? '' : 's'}` : `broker · driver in a later release${count ? ` · ${count} connection${count === 1 ? '' : 's'} saved` : ''}`}
                </span>
              </span>
              {kind.capabilities && (
                <span className="font-mono text-[11px] text-t3" title={`Up to ${Math.round(kind.capabilities.maxMessageBytes / 1024 / 1024)} MiB per message · ${kind.capabilities.delivery.join(', ')}`}>
                  {kind.capabilities.latency} latency
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

export function TransportsSettings() {
  const [data, setData] = useState<TransportsResponse>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();

  const load = () =>
    api<TransportsResponse>('/api/transports')
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  if (!data) {
    return error ? <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div> : <div className="h-56 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  }
  const brokers = data.kinds.filter((k) => !k.direct);
  const replace = (view: TransportConnectionView) =>
    setData((d) => d && { ...d, connections: d.connections.some((c) => c.id === view.id) ? d.connections.map((c) => (c.id === view.id ? view : c)) : [...d.connections, view].sort((a, b) => a.name.localeCompare(b.name)) });

  return (
    <div className="space-y-4">
      <KindsCard kinds={data.kinds} connections={data.connections} />
      <Card className="px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <SectionLabel>Broker connections</SectionLabel>
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => setDraft(draftFor(brokers[0]!, data.connections.map((c) => c.name)))} disabled={Boolean(draft) || !brokers.length}>
            <Plus className="size-3.5" /> Add connection
          </Button>
        </div>
        <p className="mb-2 text-[12px] text-t3">
          One row per installed broker. Plugins on a broker are reached as <code className="font-mono text-[11px]">{'<kind>://<connection>/<plugin>'}</code>; secrets are stored encrypted like credentials. A
          connection can also come from <code className="font-mono text-[11px]">LANDFLOW_TRANSPORT_&lt;KIND&gt;_URL</code> (read-only here).
        </p>
        {data.connections.length ? (
          <ul className="divide-y divide-hair">
            {data.connections.map((connection) => (
              <ConnectionRow key={connection.id} connection={connection} kinds={data.kinds} onEdit={() => setDraft(draftOf(connection))} onChanged={replace} onDeleted={() => void load()} />
            ))}
          </ul>
        ) : (
          <p className="py-3 text-[13px] text-t3">No broker connections yet. Plugins are reached directly over HTTP and gRPC.</p>
        )}
      </Card>
      {draft && (
        <ConnectionForm
          kinds={data.kinds}
          draft={draft}
          saved={draft.editing ? data.connections.find((c) => c.id === draft.editing) : undefined}
          onChange={setDraft}
          onDone={(view) => {
            setDraft(undefined);
            if (view) replace(view);
          }}
        />
      )}
    </div>
  );
}
