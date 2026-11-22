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
import { checkAllowList } from '@/lib/shared/ip-entry';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { HelpTip } from '@/components/ui/help-tip';
import { FieldLabel, Input, SectionLabel, Select, Textarea } from '@/components/ui/inputs';

const EXPIRY = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: '1 year' },
  { days: 0, label: 'Never' },
];

/** The lines of the address box: one entry each; commas and spaces also separate them. */
const entriesOf = (text: string) => text.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean);

/** What a key's limits say, for its row: "from 10.1.2.3" is the last address (the owner's own view), "3 of 100 uses" the cap. */
export function keyLimits(key: ApiKeyView): string[] {
  const lines: string[] = [];
  if (key.allowedIps?.length) lines.push(`only from ${key.allowedIps.length === 1 ? key.allowedIps[0] : `${key.allowedIps.length} addresses`}`);
  if (key.maxUses) lines.push(key.usedUp ? 'used up' : `${key.uses ?? 0} of ${key.maxUses} uses`);
  return lines;
}

const expired = (key: ApiKeyView) => Boolean(key.expiresAt && Date.parse(key.expiresAt) <= Date.now());

/** A key's facts under its name: when made and last used (and from where), its expiry, and its limits. */
export function KeyDetails({ apiKey: key }: { apiKey: ApiKeyView }) {
  const limits = keyLimits(key);
  return (
    <>
      <div className="mt-1 text-[11px] text-t3">
        Created {timeAgo(key.createdAt)} · {key.lastUsedAt ? `last used ${timeAgo(key.lastUsedAt)}` : 'never used'} ·{' '}
        {key.expiresAt ? `${expired(key) ? 'expired' : 'expires'} ${new Date(key.expiresAt).toLocaleDateString()}` : 'never expires'}
        {key.lastUsedIp && ` · from ${key.lastUsedIp}`}
      </div>
      {limits.length > 0 && (
        <div className="mt-0.5 text-[11px] text-t3" title={key.allowedIps?.join(', ')}>
          {limits.join(' · ')}
        </div>
      )}
    </>
  );
}

/** The new-key form. */
export function CreateKey({ onCreated, onCancel }: { onCreated: (token: string, key: ApiKeyView) => void; onCancel: () => void }) {
  const viewer = useViewer();
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<ApiKeyScope[]>(['workflows:read', 'executions:read']);
  const [days, setDays] = useState(90);
  const [addresses, setAddresses] = useState('');
  const [cap, setCap] = useState('');
  const [saving, setSaving] = useState(false);
  // The list and the cap are fixed once the key exists (no edit later): checked here with the server's own rule as they are typed.
  const list = entriesOf(addresses);
  const checked = list.length ? checkAllowList(list) : undefined;
  const problem = checked && !checked.ok ? checked.problem : undefined;
  const maxUses = cap.trim() === '' ? undefined : Number(cap);
  const capProblem = maxUses !== undefined && (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 1_000_000) ? 'Use a whole number from 1 to 1,000,000' : undefined;
  // SCIM tokens are made in Settings → Security. `audit:read` reads what its user may (project admins: their projects' events).
  const allowed = API_KEY_SCOPES.filter((s) => s !== 'scim' && (s !== 'admin' || can(viewer, 'apiKeys:admin')));
  const toggle = (scope: ApiKeyScope) => setScopes((list) => (list.includes(scope) ? list.filter((s) => s !== scope) : [...list, scope]));

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      const result = await api<{ key: ApiKeyView; token: string }>('/api/api-keys', { method: 'POST', json: { label: label.trim(), scopes, ...(days && { expiresInDays: days }), ...(checked?.ok && { allowedIps: checked.entries }), ...(maxUses && !capProblem && { maxUses }) } });
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
                <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} className="mt-0.5" />
                <span className="min-w-0">
                  <span className="block font-mono text-[12px] text-t1">{scope}</span>
                  <span className="block text-[11px] text-t3">{SCOPE_LABELS[scope]}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
          <div>
            <FieldLabel>Only from these addresses (optional)</FieldLabel>
            <Textarea value={addresses} onChange={(e) => setAddresses(e.target.value)} rows={3} placeholder={'10.0.0.0/8\n203.0.113.7'} aria-label="Only from these addresses" aria-invalid={Boolean(problem)} className="font-mono text-[12px]" />
            <p className={cn('mt-1 text-[11px]', problem ? 'text-rd' : 'text-t3')}>{problem ?? 'One address or range (10.0.0.0/8) per line, up to 50. Leave empty to allow any address. Can’t be changed later.'}</p>
          </div>
          <div>
            <FieldLabel>Stop after (optional)</FieldLabel>
            <Input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="numeric" placeholder="No limit" aria-label="Stop after this many uses" aria-invalid={Boolean(capProblem)} />
            <p className={cn('mt-1 text-[11px]', capProblem ? 'text-rd' : 'text-t3')}>{capProblem ?? 'Uses; the key is kept, marked “used up”.'}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" loading={saving} disabled={!label.trim() || scopes.length === 0 || Boolean(problem) || Boolean(capProblem)}>
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
        Keys let scripts, CI and the Landflow CLI call the API as you, limited to the scopes you pick.
        <HelpTip label="How to send a key" className="ml-1 align-middle">
          Send one as <code className="font-mono text-[12px] text-t1">Authorization: Bearer lf_…</code> (or <code className="font-mono text-[12px] text-t1">X-Landflow-API-Key</code>). The endpoints are in the{' '}
          <a href="/developers#api-reference" className="underline">API reference</a>.
        </HelpTip>
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
                  {key.usedUp && <Badge tone="danger">used up</Badge>}
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {key.scopes.map((scope) => (
                    <Badge key={scope} tone={scope === 'admin' ? 'warning' : 'muted'} className="font-mono font-medium" title={SCOPE_LABELS[scope]}>
                      {scope}
                    </Badge>
                  ))}
                </div>
                <KeyDetails apiKey={key} />
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
