'use client';
/**
 * Access → Settings (admins; docs/access-requests.md#outside-requesters): whether people without a Landflow account can ask, the
 * email domains allowed, Google sign-in with its OpenID Connect client, the page's link, and the outside requesters who signed in,
 * each with Block. `OutsideSettingsForm` is the card (no data of its own); `OutsideSettings` loads and saves.
 */
import { useEffect, useState } from 'react';
import { Ban, Globe, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { canSwitchOutsideOn, normalizeDomain, oidcCredentials, outsideAdminApi, useLoaded, type OutsideRequesterRow, type OutsideSettingsView } from '@/lib/client/access';
import type { CredentialSummary } from '@/lib/shared/types';
import { Card } from '../shell/page-header';
import { CredentialCombobox } from '../credentials/credential-combobox';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { EmptyState } from '../ui/empty-state';
import { FieldLabel, Input, Switch } from '../ui/inputs';

const when = (iso?: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');

export function OutsideSettingsForm({
  settings,
  requesters,
  credentials,
  mail,
  saving,
  dirty = true,
  error,
  onChange,
  onSave,
  onBlock,
  onUnblock,
}: {
  settings: OutsideSettingsView;
  requesters: OutsideRequesterRow[];
  credentials: CredentialSummary[];
  /** The host can send email: without it the sign-in link can't work. */
  mail: boolean;
  saving?: boolean;
  dirty?: boolean;
  error?: string;
  onChange: (settings: OutsideSettingsView) => void;
  onSave: () => void;
  onBlock: (requester: OutsideRequesterRow) => void;
  onUnblock: (requester: OutsideRequesterRow) => void;
}) {
  const [domain, setDomain] = useState('');
  const [domainProblem, setDomainProblem] = useState<string>();
  const set = (patch: Partial<OutsideSettingsView>) => onChange({ ...settings, ...patch });
  const usable = oidcCredentials(credentials);
  const addDomain = () => {
    const next = normalizeDomain(domain);
    if (!next) {
      setDomainProblem('Use your organization’s domain, like partner.com. Public mail domains and wildcards aren’t allowed.');
      return;
    }
    setDomainProblem(undefined);
    setDomain('');
    if (!settings.domains.includes(next)) set({ domains: [...settings.domains, next] });
  };
  const googleReady = !settings.google.enabled || Boolean(settings.google.credentialId);
  const canSave = dirty && (!settings.enabled || canSwitchOutsideOn(settings)) && googleReady;
  return (
    <div className="flex max-w-[760px] flex-col gap-4" data-testid="outside-settings">
      <Card className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <Switch checked={settings.enabled} disabled={!settings.enabled && !canSwitchOutsideOn(settings)} onChange={(enabled) => set({ enabled })} label="People without a Landflow account can ask" />
          <div className="min-w-0">
            <p className="text-[14px] font-semibold text-t1">People without a Landflow account can ask</p>
            <p className="text-[13px] text-t2">They sign in with their work email and can only ask for the entries you open to them. Approvers decide inside Landflow, as always.</p>
            {!settings.enabled && settings.domains.length === 0 && <p className="mt-1 text-[12px] text-t3">Add a domain first.</p>}
          </div>
        </div>

        <div>
          <FieldLabel>Email domains allowed</FieldLabel>
          <div className="flex flex-wrap gap-1.5">
            {settings.domains.map((d) => (
              <span key={d} className="inline-flex items-center gap-1 rounded-full border border-hair bg-sf2 py-0.5 pl-2.5 pr-1 text-[12.5px] text-t1">
                {d}
                <button type="button" aria-label={`Remove ${d}`} onClick={() => set({ domains: settings.domains.filter((x) => x !== d) })} className="grid size-5 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-7">
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
          <form
            className="mt-1.5 flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              addDomain();
            }}
          >
            <Input aria-label="Add an email domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="partner.com" autoCapitalize="none" autoCorrect="off" className="max-w-[260px] max-md:h-11 max-md:flex-1" />
            <Button type="submit" size="sm" variant="outline" disabled={!domain.trim()} className="max-md:h-11"><Plus className="size-3.5" /> Add</Button>
          </form>
          {domainProblem && <p role="alert" className="mt-1 text-[12px] text-rd">{domainProblem}</p>}
          <p className="mt-1 text-[12px] text-t3">Only people whose email ends in one of these can sign in. Use the plain work address, without a “+” part.</p>
        </div>

        <div>
          <FieldLabel>The page</FieldLabel>
          <div className="flex items-center gap-1.5 rounded-xl border border-hair bg-sf2 py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 truncate text-[12.5px] text-t1" data-testid="outside-link">{settings.link}</code>
            <CopyButton text={settings.link ?? ''} label="Copy the page link" className="max-md:size-11" />
          </div>
          <p className="mt-1 text-[12px] text-t3">Send this link to the people who should ask. It shows nothing until they sign in.</p>
        </div>

        {!mail && (
          <p role="alert" className="rounded-xl border border-warnbd bg-warndim px-3 py-2 text-[13px] text-warn">
            This host can't send email, so the email link can't work. People can sign in with Google only (switch it on below), or set up the mail settings first.
          </p>
        )}

        <div>
          <div className="flex items-center gap-3">
            <Switch checked={settings.google.enabled} onChange={(enabled) => set({ google: { ...settings.google, enabled } })} label="Sign in with Google" />
            <span className="text-[13px] font-semibold text-t1">Sign in with Google</span>
          </div>
          {settings.google.enabled && (
            <div className="mt-2">
              <FieldLabel>OpenID Connect client</FieldLabel>
              <CredentialCombobox
                id="outside-google-credential"
                label="OpenID Connect client"
                credentials={usable}
                value={settings.google.credentialId}
                onPick={(c) => set({ google: { ...settings.google, credentialId: c.id } })}
                onCreate={() => toast.message('Add an OpenID Connect client on the Credentials page, then pick it here')}
              />
              <p className="mt-1 text-[12px] text-t3">Only accounts of the domains above, with a verified email, can sign in. The secret stays in the vault.</p>
            </div>
          )}
        </div>

        {error && <p role="alert" className="text-[13px] text-rd">{error}</p>}
        <div>
          <Button variant="primary" loading={saving} disabled={!canSave} onClick={onSave} data-testid="outside-save" className="max-md:h-11 max-md:w-full">Save</Button>
        </div>
      </Card>

      <section aria-labelledby="outside-requesters">
        <h2 id="outside-requesters" className="mb-2 text-[13px] font-semibold text-t1">Outside requesters</h2>
        {requesters.length === 0 ? (
          <Card><EmptyState compact icon={<Globe />} title="Nobody has signed in yet" hint="People who sign in on the request page show here, and you can block one." /></Card>
        ) : (
          <ul className="flex flex-col gap-2" data-testid="outside-requesters">
            {requesters.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border border-hair bg-sf px-4 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-t1">
                    <span className="[overflow-wrap:anywhere]">{r.email}</span>
                    {r.blocked && <Badge tone="danger">Blocked</Badge>}
                  </p>
                  <p className="text-[12px] text-t3">
                    Verified by {r.verifiedBy === 'google' ? 'Google sign-in' : 'email link'} · first seen {when(r.createdAt)} · last seen {when(r.lastSeenAt)}
                  </p>
                  <p className="text-[12px] text-t3">{r.openRequests} open {r.openRequests === 1 ? 'request' : 'requests'} · {r.liveGrants} live {r.liveGrants === 1 ? 'grant' : 'grants'}</p>
                </div>
                {r.blocked ? (
                  <Button size="sm" variant="outline" onClick={() => onUnblock(r)} className="max-md:h-11 max-md:w-full">Unblock</Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => onBlock(r)} className="max-md:h-11 max-md:w-full"><Ban className="size-3.5" /> Block</Button>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[12px] text-t3">Blocking ends their sessions, cancels their open requests and sends no more links. Grants they hold stay until they end or you revoke them on the Grants tab.</p>
      </section>
    </div>
  );
}

/** The Settings tab: loads the settings, the requesters and the OpenID Connect credentials; Save, Block and Unblock call the admin routes. */
export function OutsideSettings({ mail }: { mail: boolean }) {
  const loaded = useLoaded(outsideAdminApi.settings);
  const people = useLoaded(outsideAdminApi.requesters);
  const [draft, setDraft] = useState<OutsideSettingsView>();
  const [saved, setSaved] = useState<string>();
  const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!loaded.data) return;
    const link = loaded.data.link ?? `${window.location.origin}/request-access`;
    setDraft({ ...loaded.data, link });
    setSaved(JSON.stringify({ ...loaded.data, link }));
  }, [loaded.data]);
  useEffect(() => {
    api<{ credentials: CredentialSummary[] }>('/api/credentials').then((r) => setCredentials(r.credentials)).catch(() => setCredentials([]));
  }, []);

  if (loaded.error && !draft) return <Card><EmptyState title="Settings not available" hint={loaded.error} /></Card>;
  if (!draft) return <p className="text-[13px] text-t3">Loading…</p>;

  const save = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const next = await outsideAdminApi.saveSettings(draft);
      const merged = { ...draft, ...next, link: next.link ?? draft.link };
      setDraft(merged);
      setSaved(JSON.stringify(merged));
      toast.success('Saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const act = async (work: () => Promise<unknown>, done: string) => {
    try {
      await work();
      toast.success(done);
      await people.reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  return (
    <OutsideSettingsForm
      settings={draft}
      requesters={people.data?.items ?? []}
      credentials={credentials}
      mail={mail}
      saving={saving}
      dirty={JSON.stringify(draft) !== saved}
      error={error}
      onChange={setDraft}
      onSave={() => void save()}
      onBlock={(r) => void act(() => outsideAdminApi.block(r.id), `${r.email} is blocked`)}
      onUnblock={(r) => void act(() => outsideAdminApi.unblock(r.id), `${r.email} can sign in again`)}
    />
  );
}
