'use client';
/**
 * Settings → Users → Custom roles (C32): the roles with what each grants and who holds it, New role and Edit in a
 * dialog (a bottom sheet on a phone) with one checkbox per action, Delete with a confirm that names the holders. The
 * editor disables what the viewer may not grant, with the reason: you grant only what you hold, only the owner grants
 * Manage users and Create admin API keys, and Manage projects can't be granted at all (it sees every project). The
 * server checks the same rules (lib/server/auth/roles.ts); this is the explanation, not the guard.
 */
import { useEffect, useState } from 'react';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { plural } from '@/lib/client/format';
import { ACTIONS, can, GRANTABLE_ACTIONS, OWNER_ONLY_GRANTS, ungrantable, type Action, type RoleHolder, type UserView } from '@/lib/shared/auth';
import { ACTION_LABELS, type CustomRoleView } from '@/lib/shared/roles';
import { useViewer } from '@/components/auth/viewer';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/badge';
import { Dialog, Field } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Checkbox, Input, SectionLabel } from '@/components/ui/inputs';
import { confirmAction } from '@/components/ui/confirm';

/** Why `viewer` may not tick `action`, or undefined when they may (the editor's reason under a disabled box). */
export function whyNotGrantable(viewer: RoleHolder | null | undefined, action: Action): string | undefined {
  if (!GRANTABLE_ACTIONS.includes(action)) return 'Can’t be granted through a custom role: it sees every project.';
  if (!viewer) return 'Sign in to grant it.';
  if (ungrantable(viewer, [action]).length === 0) return undefined;
  return OWNER_ONLY_GRANTS.includes(action) ? 'Only the owner can grant this.' : 'You can only grant actions you hold.';
}

export function RoleEditor({ role, onClose, onSaved }: { role?: CustomRoleView; onClose: () => void; onSaved: () => void }) {
  const viewer = useViewer();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [picked, setPicked] = useState<Set<Action>>(new Set(role?.rules.map((rule) => rule.action)));
  const [saving, setSaving] = useState(false);
  const toggle = (action: Action, on: boolean) =>
    setPicked((before) => {
      const next = new Set(before);
      if (on) next.add(action);
      else next.delete(action);
      return next;
    });
  const save = async () => {
    setSaving(true);
    try {
      const body = { name: name.trim(), description: description.trim(), rules: [...picked].map((action) => ({ action, effect: 'allow' as const })) };
      if (role) await api(`/api/users/roles/${role.id}`, { method: 'PUT', json: body });
      else await api('/api/users/roles', { method: 'POST', json: body });
      toast.success(role ? `Saved ${body.name}` : `Created ${body.name}`);
      onSaved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      title={role ? `Edit ${role.name}` : 'New role'}
      subtitle="A custom role adds actions to what a member can do. A member holds one."
      icon={<ShieldCheck className="size-4 text-t3" strokeWidth={1.8} />}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} disabled={!name.trim() || picked.size === 0} onClick={() => void save()}>
            {role ? 'Save role' : 'Create role'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="role-name" label="Name" required>
          <Input id="role-name" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} placeholder="Platform" autoFocus />
        </Field>
        <Field id="role-description" label="What it is for">
          <Input id="role-description" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} placeholder="Plugins and MCP, not users" />
        </Field>
        <fieldset className="space-y-0.5">
          <legend className="mb-1 text-[12px] font-semibold text-t2">Allowed actions</legend>
          {ACTIONS.map((action) => {
            const why = whyNotGrantable(viewer, action);
            const { label, note } = ACTION_LABELS[action];
            // An owner-only action's note already says so and says what it really allows: an admin sees it too, not only the reason.
            const ownerOnly = OWNER_ONLY_GRANTS.includes(action);
            return (
              <div key={action} className="rounded-[10px] px-1 py-0.5">
                <Checkbox checked={picked.has(action)} disabled={Boolean(why)} onChange={(on) => toggle(action, on)} label={label} />
                <p className="ml-6 text-[12px] leading-snug text-t3">{ownerOnly && note ? note : why ?? note ?? ` `}</p>
              </div>
            );
          })}
        </fieldset>
      </div>
    </Dialog>
  );
}

/** `roles` is what the first render shows before the list loads (tests render it on the server); `users` names the holders in the delete question. */
export function RolesSettings({ roles: given, users = [], onChanged }: { roles?: CustomRoleView[]; users?: UserView[]; onChanged?: () => void }) {
  const viewer = useViewer();
  const [roles, setRoles] = useState<CustomRoleView[] | undefined>(given);
  const [editing, setEditing] = useState<CustomRoleView | 'new'>();
  const [error, setError] = useState<string>();
  // With `roles` given the parent owns the list and reloads it after a change; without, this card loads its own.
  const load = (): Promise<void> | void =>
    given
      ? onChanged?.()
      : api<{ roles: CustomRoleView[] }>('/api/users/roles')
          .then((r) => setRoles(r.roles))
          .catch((e: Error) => setError(e.message));
  useEffect(() => {
    if (!given) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setRoles(given), [given]);

  const remove = async (role: CustomRoleView) => {
    const holders = users.filter((user) => user.customRole?.id === role.id).map((user) => user.name);
    const who = holders.length ? ` ${holders.join(', ')} ${holders.length === 1 ? 'holds' : 'hold'} it and will be left as ${holders.length === 1 ? 'a plain member' : 'plain members'}.` : '';
    if (!(await confirmAction(`Delete the role ${role.name}?${who}`, { action: 'Delete', danger: true }))) return;
    try {
      await api(`/api/users/roles/${role.id}${role.holders ? '?confirm=true' : ''}`, { method: 'DELETE' });
      toast.success(`Deleted ${role.name}`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) return <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;
  if (!roles) return <div className="h-24 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  const manage = can(viewer, 'users:manage');
  // Editing or deleting a role is for who could have made it (the server checks the same).
  const mayChange = (role: CustomRoleView) => manage && ungrantable(viewer!, role.rules.map((rule) => rule.action)).length === 0;

  return (
    <Card className="space-y-3 px-5 py-4">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Custom roles</SectionLabel>
        {manage && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" /> New role
          </Button>
        )}
      </div>
      {roles.length === 0 ? (
        <EmptyState compact title="No custom roles yet" hint="Give a member only what they need: plugins and MCP for a platform team, the audit log for an auditor." />
      ) : (
        <ul className="divide-y divide-hair">
          {roles.map((role) => (
            <li key={role.id} className="flex flex-wrap items-start gap-x-3 gap-y-2 py-3 first:pt-0 last:pb-0">
              <div className="min-w-0 flex-1 basis-60">
                <div className="flex items-center gap-2 text-[13px] font-semibold text-t1">
                  {role.name}
                  <span className="text-[12px] font-normal text-t3">{role.holders ? plural(role.holders, 'person', 'people') : 'no one yet'}</span>
                </div>
                {role.description && <div className="text-[12px] text-t3">{role.description}</div>}
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {role.rules.map((rule) => (
                    <span key={rule.action} title={ACTION_LABELS[rule.action]?.note}>
                      <Chip>{ACTION_LABELS[rule.action]?.label ?? rule.action}</Chip>
                    </span>
                  ))}
                </div>
              </div>
              {mayChange(role) && (
                <div className="flex items-center gap-1">
                  <Button size="icon-sm" variant="ghost" onClick={() => setEditing(role)} aria-label={`Edit ${role.name}`} title="Edit">
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => void remove(role)} aria-label={`Delete ${role.name}`} title="Delete">
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="text-[12px] text-t3">You grant only actions you hold. Only the owner grants Manage users, Manage settings, Manage plugins, Manage SCIM tokens and Create admin API keys. A role never makes a member an admin of every project.</p>
      {editing && <RoleEditor role={editing === 'new' ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => void load()} />}
    </Card>
  );
}
