'use client';
/**
 * Settings → Users (owners and admins): everyone who can sign in, pending invites, inviting by email (or a link to
 * copy without SMTP), changing roles, password reset links and removing users. The role rules are `canManageUser`.
 */
import { useEffect, useState } from 'react';
import { KeyRound, Mail, Send, Trash2, TriangleAlert, UserPlus, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { ASSIGNABLE_ROLES, can, canManageUser, ROLE_LABELS, type AssignableRole, type InviteView, type LinkResponse, type UserView } from '@/lib/shared/auth';
import { initials, useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { Input, SectionLabel, Select } from '@/components/ui/inputs';

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

export function UsersSettings() {
  const viewer = useViewer();
  const [users, setUsers] = useState<UserView[]>();
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<AssignableRole>('member');
  const [inviting, setInviting] = useState(false);
  const [notice, setNotice] = useState<{ title: string; result: LinkResponse }>();
  const [confirm, setConfirm] = useState<string>();

  const load = () =>
    api<{ users: UserView[]; invites?: InviteView[] }>('/api/users')
      .then((r) => {
        setUsers(r.users);
        setInvites(r.invites ?? []);
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
      setConfirm(undefined);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
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
        <div className="grid grid-cols-[minmax(0,1fr)_120px_minmax(0,140px)_auto] gap-3 border-b border-hair px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">
          <span>User</span>
          <span>Role</span>
          <span>Last sign-in</span>
          <span className="w-[100px]" />
        </div>
        {users.map((user) => {
          const you = user.id === viewer?.id;
          const roles = ASSIGNABLE_ROLES.filter((r) => canManageUser(viewer, user, { kind: 'role', role: r }));
          return (
            <div key={user.id} className="grid grid-cols-[minmax(0,1fr)_120px_minmax(0,140px)_auto] items-center gap-3 border-b border-hair px-4 py-2.5 last:border-b-0 hover:bg-sf2">
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="grid size-8 shrink-0 place-items-center rounded-full border border-hair bg-sf2 text-[11px] font-bold text-t2">{initials(user.name)}</span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 truncate text-[13px] font-semibold text-t1">
                    {user.name}
                    {you && <Badge tone="muted">you</Badge>}
                    {user.sso && <Badge tone="accent">SSO</Badge>}
                  </div>
                  <div className="truncate text-[12px] text-t3">{user.email}</div>
                </div>
              </div>
              <div>
                {roles.length > 0 && manage ? (
                  <Select
                    value={user.role}
                    onChange={(e) => void act(() => api(`/api/users/${user.id}`, { method: 'PATCH', json: { role: e.target.value } }), `${user.name} is now ${ROLE_LABELS[e.target.value as AssignableRole].toLowerCase()}`)}
                    aria-label={`Role of ${user.name}`}
                    className="h-8"
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
              </div>
              <span className="truncate text-[12px] text-t3" title={user.lastLoginAt}>
                {user.lastLoginAt ? timeAgo(user.lastLoginAt) : 'never'}
              </span>
              <div className="flex w-[100px] items-center justify-end gap-1">
                {confirm === user.id ? (
                  <span role="alertdialog" aria-label={`Remove ${user.name}?`} className="flex items-center gap-1 animate-fade-up">
                    <Button size="sm" variant="danger" onClick={() => void act(() => api(`/api/users/${user.id}`, { method: 'DELETE' }), `Removed ${user.name}`)}>
                      Remove
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(undefined)} aria-label="Keep">
                      <X className="size-3.5" />
                    </Button>
                  </span>
                ) : (
                  <>
                    {canManageUser(viewer, user, { kind: 'reset-password' }) && !you && (
                      <Button size="icon-sm" variant="ghost" onClick={() => void resetLink(user)} aria-label={`Password reset link for ${user.name}`} title="Password reset link">
                        <KeyRound className="size-3.5" />
                      </Button>
                    )}
                    {canManageUser(viewer, user, { kind: 'remove' }) && (
                      <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(user.id)} aria-label={`Remove ${user.name}`} title="Remove">
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </>
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
      <p className={cn('text-[12px] text-t3', !manage && 'hidden')}>Removing a user signs them out and deletes their API keys. What they built stays.</p>
    </div>
  );
}
