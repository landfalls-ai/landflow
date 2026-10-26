'use client';
/**
 * Settings → External secrets (owners and admins): connect secret stores (OpenBao / HashiCorp Vault, 1Password
 * Connect, AWS Secrets Manager, GCP Secret Manager, Azure Key Vault), test them, refresh the list of secret names
 * and use them in credential fields as `{{ $secrets.<provider>.<name> }}`. Values are read at run time and never
 * shown here; a provider's own credentials are stored encrypted like credentials and never sent back.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, KeyRound, Pencil, Plus, RefreshCw, Save, ShieldAlert, Trash2, Vault, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { SecretProviderCheck, SecretProviderField, SecretProviderKind, SecretProviderKindInfo, SecretProvidersResponse, SecretProviderView } from '@/lib/shared/secrets';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { FieldLabel, Input, SectionLabel, Select, Switch, Textarea } from '@/components/ui/inputs';

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** How a credential field references a secret: dots for plain names, brackets for paths. */
export const secretReference = (provider: string, name: string) => `{{ $secrets.${provider}${IDENTIFIER.test(name) ? `.${name}` : `[${JSON.stringify(name).replace(/"/g, "'")}]`} }}`;

interface Draft {
  /** Undefined: a new provider. */
  editing?: string;
  name: string;
  kind: SecretProviderKind;
  enabled: boolean;
  settings: Record<string, string>;
}

const draftFor = (kind: SecretProviderKindInfo, taken: string[]): Draft => {
  let name = kind.defaultName;
  for (let n = 2; taken.includes(name); n++) name = `${kind.defaultName}${n}`;
  return { name, kind: kind.kind, enabled: true, settings: Object.fromEntries(kind.fields.filter((f) => f.default !== undefined).map((f) => [f.name, String(f.default)])) };
};

const draftOf = (provider: SecretProviderView): Draft => ({
  editing: provider.name,
  name: provider.name,
  kind: provider.kind,
  enabled: provider.enabled,
  settings: Object.fromEntries(Object.entries(provider.settings).map(([k, v]) => [k, String(v)])),
});

function shown(field: SecretProviderField, values: Record<string, string>, fields: SecretProviderField[]): boolean {
  if (!field.showWhen) return true;
  const other = fields.find((f) => f.name === field.showWhen!.field);
  return field.showWhen.values.includes(values[field.showWhen.field] ?? String(other?.default ?? ''));
}

function CheckBadge({ check }: { check?: SecretProviderCheck }) {
  if (!check) return <Badge tone="muted">Not tested</Badge>;
  return (
    <Badge tone={check.ok ? 'success' : 'danger'} title={`${check.message} (${new Date(check.at).toLocaleString()})`}>
      {check.ok ? 'Connected' : 'Failing'}
    </Badge>
  );
}

function ProviderForm({ kinds, draft, saved, onChange, onDone }: { kinds: SecretProviderKindInfo[]; draft: Draft; saved?: SecretProviderView; onChange: (d: Draft) => void; onDone: (view?: SecretProviderView) => void }) {
  const kind = kinds.find((k) => k.kind === draft.kind)!;
  const [busy, setBusy] = useState<'test' | 'save'>();
  const [check, setCheck] = useState<SecretProviderCheck>();
  const set = (name: string, value: string) => onChange({ ...draft, settings: { ...draft.settings, [name]: value } });
  // Secret fields left empty keep the saved value; settings removed in the form are cleared.
  const payload = () => {
    const settings: Record<string, string | null> = {};
    for (const field of kind.fields) {
      const value = draft.settings[field.name];
      if (field.type === 'password' || field.type === 'textarea') {
        if (value) settings[field.name] = value;
      } else if (value !== undefined && value !== '') settings[field.name] = value;
      else if (saved && field.name in saved.settings) settings[field.name] = null;
    }
    return settings;
  };

  const test = async () => {
    setBusy('test');
    try {
      const result = await api<SecretProviderCheck>(`/api/external-secrets/${encodeURIComponent(draft.name || 'new')}/test`, { method: 'POST', json: { kind: draft.kind, settings: payload() } });
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
        ? await api<SecretProviderView>(`/api/external-secrets/${encodeURIComponent(draft.editing)}`, { method: 'PATCH', json: { enabled: draft.enabled, settings: payload() } })
        : await api<SecretProviderView>('/api/external-secrets', { method: 'POST', json: { name: draft.name, kind: draft.kind, enabled: draft.enabled, settings: payload() } });
      // Connect right away, so the names are there for credential fields.
      const checked = view.enabled ? await api<SecretProviderView>(`/api/external-secrets/${encodeURIComponent(view.name)}/refresh`, { method: 'POST' }).catch(() => view) : view;
      toast.success(`Saved ${view.name}${checked.lastCheck?.ok ? ` (${checked.names.length} secret${checked.names.length === 1 ? '' : 's'})` : ''}`);
      onDone(checked);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <SectionLabel>{draft.editing ? `Edit ${draft.editing}` : 'Add a provider'}</SectionLabel>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => onDone()} aria-label="Close">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>Provider</FieldLabel>
          <Select value={draft.kind} disabled={Boolean(draft.editing)} onChange={(e) => onChange({ ...draftFor(kinds.find((k) => k.kind === e.target.value)!, []), name: draft.name })}>
            {kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </Select>
          <p className="mt-1 text-[12px] text-t3">{kind.description}</p>
        </div>
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input value={draft.name} disabled={Boolean(draft.editing)} onChange={(e) => onChange({ ...draft, name: e.target.value })} spellCheck={false} />
          <p className="mt-1 font-mono text-[11px] text-t3">{`{{ $secrets.${draft.name || '…'}.<secret> }}`}</p>
        </div>
        {kind.fields
          .filter((field) => shown(field, draft.settings, kind.fields))
          .map((field) => {
            const value = draft.settings[field.name] ?? '';
            const secretSaved = saved?.secretsSet.includes(field.name);
            const placeholder = secretSaved ? '•••••••• (saved; leave empty to keep)' : field.placeholder;
            return (
              <div key={field.name} className={field.type === 'textarea' ? 'sm:col-span-2' : undefined}>
                <FieldLabel>
                  {field.label}
                  {field.required && !secretSaved ? ' *' : ''}
                </FieldLabel>
                {field.type === 'options' ? (
                  <Select value={value || String(field.default ?? '')} onChange={(e) => set(field.name, e.target.value)}>
                    {field.options?.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                ) : field.type === 'textarea' ? (
                  <Textarea value={value} onChange={(e) => set(field.name, e.target.value)} placeholder={placeholder} rows={4} spellCheck={false} className="font-mono text-[12px]" />
                ) : (
                  <Input
                    type={field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}
                    value={value}
                    onChange={(e) => set(field.name, e.target.value)}
                    placeholder={placeholder}
                    autoComplete={field.type === 'password' ? 'new-password' : 'off'}
                    spellCheck={false}
                  />
                )}
                {field.hint && <p className="mt-1 text-[12px] text-t3">{field.hint}</p>}
              </div>
            );
          })}
        <div className="flex items-center gap-2 sm:col-span-2">
          <Switch checked={draft.enabled} onChange={(v) => onChange({ ...draft, enabled: v })} label="Enabled" />
          <span className="text-[13px] text-t2">Enabled (a turned-off provider fails the credentials that reference it)</span>
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

function ProviderRow({ provider, kinds, onEdit, onChanged, onDeleted }: { provider: SecretProviderView; kinds: SecretProviderKindInfo[]; onEdit: () => void; onChanged: (v: SecretProviderView) => void; onDeleted: () => void }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'toggle' | 'delete'>();
  const [filter, setFilter] = useState('');
  const label = kinds.find((k) => k.kind === provider.kind)?.label ?? provider.kind;
  const names = useMemo(() => provider.names.filter((n) => n.toLowerCase().includes(filter.toLowerCase())), [provider.names, filter]);

  const act = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    try {
      await fn();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const refresh = () =>
    act('refresh', async () => {
      const view = await api<SecretProviderView>(`/api/external-secrets/${encodeURIComponent(provider.name)}/refresh`, { method: 'POST' });
      onChanged(view);
      if (view.lastCheck?.ok) toast.success(`${provider.name}: ${view.names.length} secret${view.names.length === 1 ? '' : 's'}`);
      else toast.error(view.lastCheck?.message ?? 'Refresh failed');
    });
  const toggle = (enabled: boolean) => act('toggle', async () => onChanged(await api<SecretProviderView>(`/api/external-secrets/${encodeURIComponent(provider.name)}`, { method: 'PATCH', json: { enabled } })));
  const remove = () =>
    act('delete', async () => {
      if (!window.confirm(`Delete ${provider.name}? Credentials that use $secrets.${provider.name} stop working until a provider of that name is back.`)) return;
      await api(`/api/external-secrets/${encodeURIComponent(provider.name)}`, { method: 'DELETE' });
      onDeleted();
    });

  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <button className="flex min-w-0 items-center gap-2 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown className="size-3.5 text-t3" /> : <ChevronRight className="size-3.5 text-t3" />}
          <span className="font-mono text-[13px] font-semibold text-t1">{provider.name}</span>
          <span className="truncate text-[12px] text-t3">{label}</span>
        </button>
        <span className="ml-auto flex items-center gap-2">
          <span className="text-[12px] text-t3">
            {provider.names.length} secret{provider.names.length === 1 ? '' : 's'}
          </span>
          <CheckBadge check={provider.lastCheck} />
          <Switch checked={provider.enabled} onChange={toggle} disabled={busy === 'toggle'} label={`Enable ${provider.name}`} />
          <Button variant="ghost" size="icon-sm" onClick={refresh} loading={busy === 'refresh'} aria-label={`Refresh ${provider.name}`} title="Reconnect and list the secret names">
            <RefreshCw className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onEdit} aria-label={`Edit ${provider.name}`}>
            <Pencil className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={remove} loading={busy === 'delete'} aria-label={`Delete ${provider.name}`}>
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </div>
      {open && (
        <div className="mt-2 rounded-[10px] border border-hair px-3 py-2">
          {provider.lastCheck && !provider.lastCheck.ok && <p className="mb-2 text-[12px] text-rd">{provider.lastCheck.message}</p>}
          {provider.names.length > 8 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter names" className="mb-2" />}
          {names.length ? (
            <ul className="max-h-64 space-y-0.5 overflow-y-auto">
              {names.map((name) => (
                <li key={name} className="flex items-center gap-2 text-[12px]">
                  <KeyRound className="size-3 shrink-0 text-t3" />
                  <span className="min-w-0 truncate font-mono text-t1">{name}</span>
                  <span className="ml-auto min-w-0 truncate font-mono text-[11px] text-t3">{secretReference(provider.name, name)}</span>
                  <CopyButton text={secretReference(provider.name, name)} label="Copy reference" />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12px] text-t3">{provider.names.length ? 'No name matches.' : 'No secret names yet: refresh to list them.'}</p>
          )}
        </div>
      )}
    </li>
  );
}

/** Where `$secrets` may be used: credential fields always; node parameters when an admin allows it. */
function WhereCard({ allowed, onChange }: { allowed: boolean; onChange: (allowed: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async (next: boolean) => {
    if (next && !window.confirm('Allow $secrets in node parameters? Anyone who can edit a workflow can then use every secret of these providers (and could send it anywhere). Values stay out of executions and logs.')) return;
    setBusy(true);
    try {
      const saved = await api<{ allowInParameters: boolean }>('/api/external-secrets', { method: 'PATCH', json: { allowInParameters: next } });
      onChange(saved.allowInParameters);
      toast.success(saved.allowInParameters ? 'Node parameters can read $secrets' : '$secrets is for credential fields only');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="px-5 py-4">
      <div className="mb-2 flex items-center gap-2">
        <ShieldAlert className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Where secrets can be used</SectionLabel>
      </div>
      <div className="flex items-start gap-3">
        <Switch checked={allowed} onChange={toggle} disabled={busy} label="Allow in node parameters" />
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-t1">Allow in node parameters</p>
          <p className="text-[12px] text-t3">
            Credential fields always can. With this on, node parameter expressions read <code className="font-mono text-[11px]">{'{{ $secrets.<provider>.<name> }}'}</code> too, when the workflow runs (in the
            host and in workers); the editor suggests the names. Values are never stored: executions, checkpoints, pinned data, logs, errors and live events show{' '}
            <code className="font-mono text-[11px]">[redacted]</code>. Off: a parameter that reads <code className="font-mono text-[11px]">$secrets</code> fails its node. Every workflow editor can use every secret, so
            turn it on only if you trust them all.
          </p>
        </div>
      </div>
    </Card>
  );
}

export function ExternalSecretsSettings() {
  const [data, setData] = useState<SecretProvidersResponse>();
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<Draft>();

  const load = () =>
    api<SecretProvidersResponse>('/api/external-secrets')
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  if (!data) {
    return error ? <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div> : <div className="h-56 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  }
  const replace = (view: SecretProviderView) => setData((d) => d && { ...d, providers: d.providers.some((p) => p.name === view.name) ? d.providers.map((p) => (p.name === view.name ? view : p)) : [...d.providers, view].sort((a, b) => a.name.localeCompare(b.name)) });

  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="mb-2 flex items-center gap-2">
          <Vault className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Providers</SectionLabel>
          {!draft && (
            <Button size="sm" variant="primary" className="ml-auto" onClick={() => setDraft(draftFor(data.kinds[0], data.providers.map((p) => p.name)))}>
              <Plus className="size-3.5" /> Add provider
            </Button>
          )}
        </div>
        <p className="text-[13px] text-t2">
          Reference a secret in any credential field{data.allowInParameters ? ' (and node parameter)' : ''} as <code className="font-mono text-[12px]">{'{{ $secrets.<provider>.<name> }}'}</code> (a JSON secret’s key:{' '}
          <code className="font-mono text-[12px]">{'{{ $secrets.vault.db.password }}'}</code>). Values are fetched when a workflow runs, kept for {data.cacheTtlSeconds ? `${data.cacheTtlSeconds} s` : 'no time'} and
          never stored with executions{data.environment ? <> ; <code className="font-mono text-[12px]">{'{environment}'}</code> in a path or prefix is {data.environment}</> : null}.
        </p>
        {data.providers.length ? (
          <ul className="mt-2 divide-y divide-hair">
            {data.providers.map((provider) => (
              <ProviderRow
                key={provider.name}
                provider={provider}
                kinds={data.kinds}
                onEdit={() => setDraft(draftOf(provider))}
                onChanged={replace}
                onDeleted={() => setData((d) => d && { ...d, providers: d.providers.filter((p) => p.name !== provider.name) })}
              />
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-[13px] text-t3">No providers yet.</p>
        )}
      </Card>
      <WhereCard allowed={data.allowInParameters} onChange={(allowInParameters) => setData((d) => d && { ...d, allowInParameters })} />
      {draft && (
        <ProviderForm
          key={draft.editing ?? 'new'}
          kinds={data.kinds}
          draft={draft}
          saved={draft.editing ? data.providers.find((p) => p.name === draft.editing) : undefined}
          onChange={setDraft}
          onDone={(view) => {
            if (view) replace(view);
            setDraft(undefined);
          }}
        />
      )}
    </div>
  );
}
