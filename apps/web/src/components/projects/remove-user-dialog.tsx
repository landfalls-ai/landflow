'use client';
/**
 * Removing a user (Settings → Users): when their personal project owns workflows, credentials, data tables or agents,
 * choose who or which project gets them; the move and the removal run in one transaction
 * (DELETE /api/users/<id> { transferTo }).
 */
import { useEffect, useState } from 'react';
import { UserMinus } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { UserView } from '@/lib/shared/auth';
import type { ResourceKind, TransferTarget } from '@/lib/shared/projects';
import { Dialog, Field } from '@/components/agents/dialog';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/inputs';
import { describeCounts } from './project-dialogs';
import { useProjects } from './use-projects';

export function RemoveUserDialog({ user, users, viewerId, onClose, onRemoved }: { user: UserView; users: UserView[]; viewerId?: string; onClose: () => void; onRemoved: () => void }) {
  const { projects } = useProjects();
  const [owned, setOwned] = useState<{ counts: Partial<Record<ResourceKind, number>>; total: number }>();
  const [target, setTarget] = useState(viewerId && viewerId !== user.id ? `user:${viewerId}` : '');
  const [removing, setRemoving] = useState(false);

  useEffect(() => {
    api<{ counts: Partial<Record<ResourceKind, number>>; total: number }>(`/api/users/${user.id}/resources`)
      .then(setOwned)
      .catch((e: Error) => toast.error(e.message));
  }, [user.id]);

  const remove = async () => {
    setRemoving(true);
    try {
      const [kind, id] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
      const transferTo: TransferTarget | undefined = owned?.total ? (kind === 'user' ? { userId: id } : { projectId: id }) : undefined;
      await api(`/api/users/${user.id}`, { method: 'DELETE', json: transferTo ? { transferTo } : {} });
      toast.success(`Removed ${user.name}`);
      onRemoved();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
      setRemoving(false);
    }
  };

  const people = users.filter((u) => u.id !== user.id && !u.disabled);
  const teams = (projects ?? []).filter((p) => p.type === 'team');
  const needsTarget = Boolean(owned?.total);

  return (
    <Dialog
      title={`Remove ${user.name}?`}
      subtitle={user.email}
      icon={<UserMinus className="size-4 text-rd" />}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void remove()} loading={removing} disabled={!owned || (needsTarget && !target)}>
            Remove user
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-[13px] text-t1">
        <p>They are signed out everywhere, their API keys stop working and they leave every project.</p>
        {!owned ? (
          <p className="text-t3">Checking what they own…</p>
        ) : needsTarget ? (
          <Field id="remove-user-target" label={`Their personal project owns ${describeCounts(owned.counts)}. Move it to`} required hint="Shares made to them end. What moves keeps its shares.">
            <Select id="remove-user-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a person or project…</option>
              <optgroup label="People (their personal project)">
                {people.map((u) => (
                  <option key={u.id} value={`user:${u.id}`}>
                    {u.name}
                    {u.id === viewerId ? ' (you)' : ''} · {u.email}
                  </option>
                ))}
              </optgroup>
              {teams.length > 0 && (
                <optgroup label="Projects">
                  {teams.map((p) => (
                    <option key={p.id} value={`project:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          </Field>
        ) : (
          <p className="text-t3">Their personal project owns nothing.</p>
        )}
      </div>
    </Dialog>
  );
}
