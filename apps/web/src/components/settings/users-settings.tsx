'use client';
/**
 * Settings → Users (owners and admins): everyone who can sign in, pending invites, inviting by email (or a link to
 * copy without SMTP), changing roles, giving a member a custom role (C32; the Custom roles card under the list),
 * password reset links and removing users. The role rules are `canManageUser`.
 */
import { useEffect, useState } from 'react';
import { KeyRound, Mail, Send, ShieldOff, Trash2, TriangleAlert, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { ASSIGNABLE_ROLES, can, canManageUser, canResetMfa, ROLE_LABELS, ungrantable, type AssignableRole, type InviteView, type LinkResponse, type UserView } from '@/lib/shared/auth';
import type { CustomRoleView } from '@/lib/shared/roles';
import { initials, useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input, SectionLabel, Select } from '@/components/ui/inputs';
import { confirmAction } from '@/components/ui/confirm';
import { RemoveUserDialog } from '@/components/projects/remove-user-dialog';
import { RolesSettings } from './roles-settings';

/** A link that was just made: emailed, or to copy. */
function LinkNotice({ title, result, onClose }: { title: string; result: LinkResponse; onClose: () => void }) {
  return (
    <div className="space-y-2 rounded-[10px] border border-hair bg-sf2 px-3 py-2.5 animate-fade-up">
      <div className="flex items-start gap-2 text-[12px]">
        {result.emailed ? <Mail className="mt-0.5 size-3.5 shrink-0 text-gn" /> : <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" />}
        <span className="min-w-0 flex-1 text-t2">
          <span className="font-semibold text-t1">{title}.</span>{' '}
          {result.emailed ? 'It was emailed; you can also copy the link.' : result.emailError ? `Sending the email failed (${result.emailError}): copy the link and send it yourself.` : 'Email isn’t configured: copy the link and send it yourself.'}
        </span>
        <button onClick={onClose} aria-label="Dismiss" className="text-t3 hover:text-t1">
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1">{result.link}</code>
        <CopyButton text={result.link} label="Copy link" />
      </div>
    </div>
  );
}

/** `initial` is what the first render shows before the list loads (tests render it on the server). */
export function UsersSettings({ initial }: { initial?: UserView[] } = {}) {
  const viewer = useViewer();
  const [users, setUsers] = useState<UserView[] | undefined>(initial);
  const [customRoles, setCustomRoles] = useState<CustomRoleView[]>([]);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<{ title: string; result: LinkResponse }>();
  const [removing, setRemoving] = useState<UserView>();

  const load = () =>
    Promise.all([api<{ users: UserView[]; invites?: InviteView[] }>('/api/users'), api<{ roles: CustomRoleView[] }>('/api/users/roles')])
      .then(([r, custom]) => {
        setUsers(r.users);
        setInvites(r.invites ?? []);
        setCustomRoles(custom.roles);
      })
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);

  const manage = can(viewer, 'users:manage');

  const invite = async (event: React.FormEvent) => {
    event.preventDefault();
    setInviting(true);
    try {
      const result = await api<LinkResponse & { invite: InviteView }>('/api/users/invites', { method: 'POST', json: { email: email.trim(), role } });
      setNotice({ title: `Invited ${result.invite.email}`, result });
      setEmail('');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setInviting(false);
    }
  };
  const act = async (run: () => Promise<unknown>, done: string) => {
    try {
      await run();
      toast.success(done);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  const resetSecondFactor = async (user: UserView) => {
    if (!(await confirmAction(`Reset the second factor of ${user.name}? Their authenticator app and recovery codes stop working and they are signed out everywhere.`, { action: 'Reset', danger: true }))) return;
    await act(() => api(`/api/users/${user.id}/mfa`, { method: 'DELETE' }), `Reset the second factor of ${user.name}`);
  };
  const resetLink = async (user: UserView) => {
    try {
      const result = await api<LinkResponse>(`/api/users/${user.id}/password-reset`, { method: 'POST' });
      setNotice({ title: `Password reset link for ${user.name}`, result });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) return <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;
  if (!users) return <div className="h-48 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;

  const roleOptions = ASSIGNABLE_ROLES.filter((r) => viewer?.role === 'owner' || r !== 'admin');

  return (
    <div className="space-y-4">
      {manage && (
        <Card className="space-y-3 px-5 py-4">
          <div className="flex items-center gap-2">
            <UserPlus className="size-4 text-t3" strokeWidth={1.8} />
            <SectionLabel>Invite someone</SectionLabel>
          </div>
          <form onSubmit={invite} className="flex flex-wrap items-center gap-2">
            <Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" className="min-w-[220px] flex-1" aria-label="Email" />
            <div className="w-32">
              <Select value={role} onChange={(e) => setRole(e.target.value as AssignableRole)} aria-label="Role">
                {roleOptions.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            </div>
            <Button type="submit" variant="primary" loading={inviting}>
              <Send className="size-3.5" /> Invite
            </Button>
          </form>
          <p className="text-[12px] text-t3">Members build and run workflows. Admins also manage users, settings, credentials sharing and the MCP server. Only the owner invites admins.</p>
          {notice && <LinkNotice title={notice.title} result={notice.result} onClose={() => setNotice(undefined)} />}
        </Card>
      )}

      <Card className="overflow-hidden p-0">
        <div className="grid grid-cols-[minmax(0,1fr)_150px_minmax(0,140px)_auto] gap-3 border-b border-hair px-4 py-2 text-[11px] max-md:hidden font-semibold uppercase tracking-[0.06em] text-t3">
          <span>User</span>
          <span>Role</span>
          <span>Last sign-in</span>
          <span className="w-[132px]" />
        </div>
        {users.map((user) => {
          const you = user.id === viewer?.id;
          const roles = ASSIGNABLE_ROLES.filter((r) => canManageUser(viewer, user, { kind: 'role', role: r }));
          return (
            <div key={user.id} className="grid grid-cols-[minmax(0,1fr)_150px_minmax(0,140px)_auto] items-center gap-3 border-b border-hair px-4 py-2.5 last:border-b-0 hover:bg-sf2 max-md:flex max-md:flex-col max-md:items-stretch max-md:gap-2.5">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-hair bg-sf2 text-[11px] font-bold text-t2">{initials(user.name)}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-t1">
                    {user.name}
                    {you && <Badge tone="muted">you</Badge>}
                    {user.sso && <Badge tone="accent">SSO</Badge>}
                    {Boolean(user.mfaFactors) && <Badge tone="success" title="Has a second factor">2-step</Badge>}
                    {user.provisionedBy && <Badge tone="muted" title="Created and kept in sync by your identity provider">{user.provisionedBy.toUpperCase()}</Badge>}
                    {user.disabled && <Badge tone="warning">deactivated</Badge>}
                  </div>
                  <div className="truncate text-[12px] text-t3">{user.email}</div>
                </div>
              </div>
              <div className="space-y-1">
                {roles.length > 0 && manage ? (
                  <Select
                    value={user.role}
                    onChange={(e) => void act(() => api(`/api/users/${user.id}`, { method: 'PATCH', json: { role: e.target.value } }), `${user.name} is now ${ROLE_LABELS[e.target.value as AssignableRole].toLowerCase()}`)}
                    aria-label={`Role of ${user.name}`}
                    className="h-8 max-md:h-11"
                  >
                    {[...new Set([user.role, ...roles])].map((r) => (
                      <option key={r} value={r} disabled={r === 'owner'}>
                        {ROLE_LABELS[r]}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Badge tone={user.role === 'owner' ? 'accent' : user.role === 'admin' ? 'success' : 'neutral'}>{ROLE_LABELS[user.role]}</Badge>
                )}
                {user.role === 'member' && (manage && customRoles.length > 0 && canManageUser(viewer, user, { kind: 'role', role: 'member' }) ? (
                  <Select
                    value={user.customRole?.id ?? ''}
                    onChange={(e) =>
                      void act(
                        () => api(`/api/users/${user.id}`, { method: 'PATCH', json: { customRoleId: e.target.value || null } }),
                        e.target.value ? `${user.name} now holds ${customRoles.find((r) => r.id === e.target.value)?.name ?? 'the role'}` : `${user.name} holds no custom role`,
                      )
                    }
                    aria-label={`Custom role of ${user.name}`}
                    className="h-8 max-md:h-11"
                  >
                    <option value="">No custom role</option>
                    {customRoles.map((r) => (
                      <option key={r.id} value={r.id} disabled={ungrantable(viewer ?? { role: 'member' }, r.rules.map((rule) => rule.action)).length > 0} title={ungrantable(viewer ?? { role: 'member' }, r.rules.map((rule) => rule.action)).length > 0 ? 'You can only give a role whose actions you hold' : undefined}>
                        {r.name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  user.customRole && <Badge tone="accent" title="Custom role">{user.customRole.name}</Badge>
                ))}
              </div>
              <span className="truncate text-[12px] text-t3" title={user.lastLoginAt}>
                <span className="md:hidden">Last sign-in: </span>
                {user.lastLoginAt ? timeAgo(user.lastLoginAt) : 'never'}
              </span>
              <div className="flex w-[132px] items-center justify-end gap-1 max-md:w-auto max-md:justify-start max-md:gap-2">
                {manage && Boolean(user.mfaFactors) && canResetMfa(viewer, user) && (
                  <Button size="icon-sm" variant="ghost" className="max-md:size-11" onClick={() => void resetSecondFactor(user)} aria-label={`Reset second factor of ${user.name}`} title="Reset second factor">
                    <ShieldOff className="size-3.5" />
                  </Button>
                )}
                {canManageUser(viewer, user, { kind: 'reset-password' }) && !you && (
                  <Button size="icon-sm" variant="ghost" className="max-md:size-11" onClick={() => void resetLink(user)} aria-label={`Password reset link for ${user.name}`} title="Password reset link">
                    <KeyRound className="size-3.5" />
                  </Button>
                )}
                {canManageUser(viewer, user, { kind: 'remove' }) && (
                  <Button size="icon-sm" variant="ghost" className="max-md:size-11" onClick={() => setRemoving(user)} aria-label={`Remove ${user.name}`} title="Remove">
                    <Trash2 className="size-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </Card>

      {manage && invites.length > 0 && (
        <Card className="overflow-hidden p-0">
          <div className="border-b border-hair px-4 py-2">
            <SectionLabel>Pending invites</SectionLabel>
          </div>
          {invites.map((pending) => (
            <div key={pending.id} className="flex items-center gap-3 border-b border-hair px-4 py-2.5 last:border-b-0 hover:bg-sf2">
              <Mail className="size-4 shrink-0 text-t3" strokeWidth={1.8} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] text-t1">{pending.email}</div>
                <div className="truncate text-[12px] text-t3">
                  {ROLE_LABELS[pending.role]}
                  {pending.invitedBy && ` · invited by ${pending.invitedBy}`} · expires {new Date(pending.expiresAt).toLocaleDateString()}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  void api<LinkResponse & { invite: InviteView }>('/api/users/invites', { method: 'POST', json: { email: pending.email, role: pending.role } })
                    .then((result) => {
                      setNotice({ title: `New invite for ${pending.email}`, result });
                      return load();
                    })
                    .catch((e: Error) => toast.error(e.message))
                }
                title="Make a new link (the old one stops working)"
              >
                Resend
              </Button>
              <Button size="icon-sm" variant="ghost" onClick={() => void act(() => api(`/api/users/invites/${pending.id}`, { method: 'DELETE' }), `Revoked the invite for ${pending.email}`)} aria-label={`Revoke the invite for ${pending.email}`} title="Revoke">
                <X className="size-3.5" />
              </Button>
            </div>
          ))}
        </Card>
      )}
      <RolesSettings roles={customRoles} users={users} onChanged={() => void load()} />
      <p className={cn('text-[12px] text-t3', !manage && 'hidden')}>Removing a user signs them out and deletes their API keys. What their personal project owns moves to the person or project you choose.</p>
      {removing && <RemoveUserDialog user={removing} users={users} viewerId={viewer?.id} onClose={() => setRemoving(undefined)} onRemoved={() => void load()} />}
    </div>
  );
}
