'use client';
/**
 * Settings → API keys: your keys for scripts, CI and the CLI (`Authorization: Bearer lf_…`). A new key is shown once;
 * Landflow keeps only its hash. Keys act as you, limited to their scopes, and stop working when they expire.
 */
import { useEffect, useState } from 'react';
import { KeyRound, Plus, ShieldAlert, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { API_KEY_SCOPES, can, SCOPE_LABELS, type ApiKeyScope, type ApiKeyView } from '@/lib/shared/auth';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, SectionLabel, Select } from '@/components/ui/inputs';

const EXPIRY = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 0, label: 'Never' },
];

const expired = (key: ApiKeyView) => Boolean(key.expiresAt && Date.parse(key.expiresAt) <= Date.now());

/** The new-key form. */
function CreateKey({ onCreated, onCancel }: { onCreated: (token: string, key: ApiKeyView) => void; onCancel: () => void }) {
  const viewer = useViewer();
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['workflows:read', 'executions:read']);
  const [days, setDays] = useState(90);
  const [saving, setSaving] = useState(false);
  // SCIM tokens are made in Settings → Security.
  const allowed = API_KEY_SCOPES.filter((s) => s !== 'scim' && (s !== 'admin' || can(viewer, 'apiKeys:admin')) && (s !== 'audit:read' || can(viewer, 'audit:read')));
  const toggle = (scope: ApiKeyScope) => setScopes((list) => (list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope]));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api<{ key: ApiKeyView; token: string }>('/api/api-keys', { method: 'POST', json: { label: label.trim(), scopes, ...(days && { expiresInDays: days }) } });
      onCreated(result.token, result.key);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="px-5 py-4 animate-fade-up">
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
          <div>
            <FieldLabel>Name</FieldLabel>
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="CI deploys" required maxLength={100} autoFocus aria-label="Key name" />
          </div>
          <div>
            <FieldLabel>Expires</FieldLabel>
            <Select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="Expires">
              {EXPIRY.map((option) => (
                <option key={option.days} value={option.days}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <FieldLabel>Scopes</FieldLabel>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {allowed.map((scope) => (
              <label key={scope} className={cn('flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-2', scopes.includes(scope) ? 'border-acbd bg-acdim' : 'border-hair hover:bg-sf2')}>
                <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} className="mt-0.5 accent-[var(--ac)]" />
                <span className="min-w-0">
                  <span className="block font-mono text-[12px] text-t1">{scope}</span>
                  <span className="block text-[11px] text-t3">{SCOPE_LABELS[scope]}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!label.trim() || scopes.length === 0}>
            Create key
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function ApiKeysSettings() {
  const [keys, setKeys] = useState<ApiKeyView[]>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: string; label: string }>();
  const [confirm, setConfirm] = useState<string>();

  const load = () =>
    api<{ keys: ApiKeyView[] }>('/api/api-keys')
      .then((r) => setKeys(r.keys))
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const revoke = async (key: ApiKeyView) => {
    try {
      await api(`/api/api-keys/${key.id}`, { method: 'DELETE' });
      toast.success(`Revoked ${key.label}`);
      setConfirm(undefined);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) return <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;
  if (!keys) return <div className="h-40 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-t2">
        Keys let scripts, CI and the Landflow CLI call the API as you, limited to the scopes you pick. Send one as <code className="font-mono text-[12px] text-t1">Authorization: Bearer lf_…</code> (or{' '}
        <code className="font-mono text-[12px] text-t1">X-Landflow-API-Key</code>).
      </p>

      {created && (
        <Card className="space-y-2 border-acbd px-5 py-4 animate-fade-up">
          <div className="flex items-start gap-2 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 text-t2">
              <span className="font-semibold text-t1">Copy “{created.label}” now.</span> You won’t see this key again; Landflow keeps only a hash of it.
            </span>
            <button onClick={() => setCreated(undefined)} aria-label="Dismiss" className="text-t3 hover:text-t1">
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" data-testid="new-api-key">
              {created.token}
            </code>
            <CopyButton text={created.token} label="Copy key" />
          </div>
        </Card>
      )}

      {creating ? (
        <CreateKey
          onCancel={() => setCreating(false)}
          onCreated={(token, key) => {
            setCreated({ token, label: key.label });
            setCreating(false);
            void load();
          }}
        />
      ) : (
        <div className="flex">
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" /> New API key
          </Button>
        </div>
      )}

      {keys.length === 0 ? (
        !creating && <EmptyState title="No API keys" hint="Create one for a script, CI job or the Landflow CLI." compact />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="border-b border-hair px-4 py-2">
            <SectionLabel>Your keys</SectionLabel>
          </div>
          {keys.map((key) => (
            <div key={key.id} className="flex items-start gap-3 border-b border-hair px-4 py-2.5 last:border-b-0 hover:bg-sf2">
              <KeyRound className="mt-0.5 size-4 shrink-0 text-t3" strokeWidth={1.8} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-t1">
                  <span className="truncate">{key.label}</span>
                  <code className="font-mono text-[11px] font-normal text-t3">lf_…{key.hint}</code>
                  {expired(key) && <Badge tone="danger">expired</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {key.scopes.map((scope) => (
                    <Badge key={scope} tone={scope === 'admin' ? 'warning' : 'muted'} className="font-mono font-medium" title={SCOPE_LABELS[scope]}>
                      {scope}
                    </Badge>
                  ))}
                </div>
                <div className="mt-1 text-[11px] text-t3">
                  Created {timeAgo(key.createdAt)} · {key.lastUsedAt ? `last used ${timeAgo(key.lastUsedAt)}` : 'never used'} ·{' '}
                  {key.expiresAt ? `${expired(key) ? 'expired' : 'expires'} ${new Date(key.expiresAt).toLocaleDateString()}` : 'never expires'}
                </div>
              </div>
              {confirm === key.id ? (
                <span role="alertdialog" aria-label={`Revoke ${key.label}?`} className="flex items-center gap-1 animate-fade-up">
                  <Button size="sm" variant="danger" onClick={() => void revoke(key)}>
                    Revoke
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(undefined)} aria-label="Keep">
                    <X className="size-3.5" />
                  </Button>
                </span>
              ) : (
                <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(key.id)} aria-label={`Revoke ${key.label}`} title="Revoke">
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
