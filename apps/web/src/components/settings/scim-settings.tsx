'use client';
/**
 * Settings → Security → SCIM provisioning (owners and admins): the base URL to give Okta or Entra ID, SCIM tokens
 * (API keys with only the `scim` scope, shown once, revocable here) and the group → project/role map
 * (LANDFLOW_SCIM_GROUP_MAP). Rendered by ./security-settings with the `scim` part of GET /api/settings/security.
 */
import { useState } from 'react';
import { KeyRound, Plus, ShieldAlert, Trash2, UsersRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { ApiKeyView, ScimSecurityView, SecurityView } from '@/lib/shared/auth';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input, SectionLabel } from '@/components/ui/inputs';

const code = (text: string) => <code className="font-mono text-[12px] text-t1">{text}</code>;

export function ScimSettings({ scim: initial }: { scim: ScimSecurityView }) {
  const [scim, setScim] = useState(initial);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ token: string; label: string }>();
  const [confirm, setConfirm] = useState<string>();

  const reload = () =>
    api<SecurityView>('/api/settings/security')
      .then((view) => view.scim && setScim(view.scim))
      .catch(() => {});

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    try {
      const result = await api<{ key: ApiKeyView; token: string }>('/api/api-keys', { method: 'POST', json: { label: label.trim() || 'SCIM', scopes: ['scim'] } });
      setCreated({ token: result.token, label: result.key.label });
      setLabel('');
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: ApiKeyView) => {
    try {
      await api(`/api/api-keys/${key.id}`, { method: 'DELETE' });
      toast.success(`Revoked ${key.label}`);
      setConfirm(undefined);
      await reload();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const groupMap = Object.entries(scim.groupMap);

  return (
    <Card className="space-y-3 px-5 py-4">
      <div className="flex items-center gap-2">
        <UsersRound className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Provisioning (SCIM 2.0)</SectionLabel>
        <span className="ml-auto flex gap-1">
          <Badge tone="muted">{scim.provisionedUsers} provisioned</Badge>
          <Badge tone="muted">{scim.groups} groups</Badge>
        </span>
      </div>
      <p className="text-[13px] text-t2">
        Okta, Entra ID and other identity providers create, update and deactivate users here, and push groups that become project memberships or roles. Give them the base URL and a SCIM token
        (HTTP header bearer token). Deactivated users are signed out and can’t sign in.
      </p>
      <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
        <span className="shrink-0 text-[12px] text-t3">Base URL</span>
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1">{scim.baseUrl}</code>
        <CopyButton text={scim.baseUrl} label="Copy SCIM base URL" />
      </div>

      {created && (
        <div className="space-y-2 rounded-[10px] border border-acbd bg-sf2 px-3 py-2.5 animate-fade-up">
          <div className="flex items-start gap-2 text-[12px]">
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />
            <span className="min-w-0 flex-1 text-t2">
              <span className="font-semibold text-t1">Copy “{created.label}” now.</span> You won’t see this token again.
            </span>
            <button onClick={() => setCreated(undefined)} aria-label="Dismiss" className="text-t3 hover:text-t1">
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" data-testid="new-scim-token">
              {created.token}
            </code>
            <CopyButton text={created.token} label="Copy token" />
          </div>
        </div>
      )}

      <form onSubmit={create} className="flex flex-wrap items-center gap-2">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Okta provisioning" maxLength={100} className="min-w-[200px] flex-1" aria-label="Token name" />
        <Button type="submit" variant="primary" loading={creating}>
          <Plus className="size-3.5" /> New SCIM token
        </Button>
      </form>

      {scim.tokens.length > 0 && (
        <div className="divide-y divide-hair rounded-[10px] border border-hair">
          {scim.tokens.map((key) => (
            <div key={key.id} className="flex items-center gap-3 px-3 py-2">
              <KeyRound className="size-4 shrink-0 text-t3" strokeWidth={1.8} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-t1">
                  <span className="truncate">{key.label}</span>
                  <code className="font-mono text-[11px] font-normal text-t3">lf_…{key.hint}</code>
                </div>
                <div className="text-[11px] text-t3">
                  {key.userName} · created {timeAgo(key.createdAt)} · {key.lastUsedAt ? `last used ${timeAgo(key.lastUsedAt)}` : 'never used'}
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
        </div>
      )}

      <div className="text-[13px]">
        <div className="mb-1 text-t3">Group mapping {code('LANDFLOW_SCIM_GROUP_MAP')}</div>
        {groupMap.length ? (
          <span className="flex flex-wrap gap-1">
            {groupMap.map(([group, target]) => (
              <Badge key={group} tone="muted" className="font-mono font-medium">
                {group} → {target}
              </Badge>
            ))}
          </span>
        ) : (
          <span className="text-t2">
            None: a group named like a team project makes its members editors there. Map groups with {code('Landflow Admins=role:admin,Data Team=project:Data:editor')}.
          </span>
        )}
      </div>
    </Card>
  );
}
