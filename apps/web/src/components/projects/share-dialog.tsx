'use client';
/**
 * Share and Move dialogs for workflows and credentials (and Move for data tables and agents). Sharing grants a user
 * (their personal project) or a team project access: workflows as editor or viewer, credentials as "can use" (the
 * secret is never shown to anyone it is shared with). Moving changes the home project; the server checks the
 * caller is an admin of the current project and an editor of the target (lib/shared/projects.ts).
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, Share2, Trash2, UserRound, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { UserView } from '@/lib/shared/auth';
import { personalProjectId, SHARE_ROLES, type ProjectType, type ResourceKind, type ResourceOwnership, type ShareableKind, type ShareRole, type ShareView } from '@/lib/shared/projects';
import { useViewer } from '@/components/auth/viewer';
import { Dialog } from '@/components/agents/dialog';
import { Button } from '@/components/ui/button';
import { FieldLabel, Select } from '@/components/ui/inputs';
import { projectLabel, useProjects, writableProjects } from './use-projects';

/** The API collection of each kind. */
export const RESOURCE_PATH: Record<ResourceKind, string> = { workflow: '/api/workflows', credential: '/api/credentials', dataTable: '/api/data-tables', agent: '/api/agents', agentTeam: '/api/agent-teams' };
const NOUN: Record<ResourceKind, string> = { workflow: 'workflow', credential: 'credential', dataTable: 'data table', agent: 'agent', agentTeam: 'agent team' };
const ROLE_LABEL: Record<ShareRole, string> = { editor: 'Can edit', viewer: 'Can view', user: 'Can use' };

interface Target {
  id: string;
  name: string;
  type: ProjectType;
  ownerId?: string;
}

/** Share a workflow or credential with users and projects (PUT `/api/<kind>/<id>/shares`). */
export function ShareDialog({ kind, id, name, onClose, onChanged }: { kind: ShareableKind; id: string; name: string; onClose: () => void; onChanged?: () => void }) {
  const viewer = useViewer();
  const [ownership, setOwnership] = useState<ResourceOwnership>();
  const [shares, setShares] = useState<Array<Pick<ShareView, 'projectId' | 'role'>>>();
  const [targets, setTargets] = useState<Target[]>([]);
  const [users, setUsers] = useState<UserView[]>([]);
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState(false);
  const roles = SHARE_ROLES[kind] as readonly ShareRole[];

  useEffect(() => {
    let live = true;
    void Promise.all([
      api<{ ownership: ResourceOwnership; shares: ShareView[] }>(`${RESOURCE_PATH[kind]}/${id}/shares`),
      api<{ projects: Target[] }>('/api/projects?targets=1').catch(() => ({ projects: [] as Target[] })),
      api<{ users: UserView[] }>('/api/users').catch(() => ({ users: [] as UserView[] })),
    ])
      .then(([current, projects, people]) => {
        if (!live) return;
        setOwnership(current.ownership);
        setShares(current.shares.map((s) => ({ projectId: s.projectId, role: s.role })));
        setTargets(projects.projects);
        setUsers(people.users);
      })
      .catch((e) => toast.error((e as Error).message));
    return () => {
      live = false;
    };
  }, [kind, id]);

  const byId = useMemo(() => new Map(targets.map((t) => [t.id, t])), [targets]);
  const userOf = (target?: Target) => (target?.type === 'personal' ? users.find((u) => u.id === target.ownerId) : undefined);
  const describe = (target?: Target) => {
    const user = userOf(target);
    if (user) return { title: user.id === viewer?.id ? `${user.name} (you)` : user.name, hint: user.email, icon: UserRound };
    return { title: target?.name ?? 'Unknown project', hint: 'Team project', icon: Users };
  };
  const canShare = ownership?.access.home && ownership.access.role === 'admin';
  const taken = new Set([ownership?.projectId, ...(shares ?? []).map((s) => s.projectId)]);
  const options = targets.filter((t) => !taken.has(t.id) && (t.type === 'team' || users.some((u) => u.id === t.ownerId)));

  const save = async () => {
    if (!shares) return;
    setSaving(true);
    try {
      await api(`${RESOURCE_PATH[kind]}/${id}/shares`, { method: 'PUT', json: { shares } });
      toast.success(shares.length ? `Shared “${name}”` : `“${name}” is no longer shared`);
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title={`Share “${name}”`}
      subtitle={ownership && `Owned by ${ownership.projectType === 'personal' && viewer && ownership.projectId === personalProjectId(viewer.id) ? 'your personal project' : ownership.projectName}`}
      icon={<Share2 className="size-4 text-t2" />}
      width={520}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {canShare ? 'Cancel' : 'Close'}
          </Button>
          {canShare && (
            <Button variant="primary" onClick={() => void save()} loading={saving} disabled={!shares}>
              Save
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[12px] text-t2">
          {kind === 'workflow'
            ? 'People and projects you share with see this workflow in their lists. Editors can change and run it; viewers can open it and its executions.'
            : 'People and projects you share with can choose this credential in their workflows’ nodes. They never see its secret values, and can’t change or delete it.'}
        </p>
        {canShare && (
          <div>
            <FieldLabel>Share with</FieldLabel>
            <div className="flex gap-2">
              <div className="min-w-0 flex-1">
                <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="User or project to share with">
                  <option value="">Choose a person or project…</option>
                  {options.filter((t) => t.type === 'personal').length > 0 && (
                    <optgroup label="People">
                      {options.filter((t) => t.type === 'personal').map((t) => (
                        <option key={t.id} value={t.id}>
                          {describe(t).title} · {describe(t).hint}
                        </option>
                      ))}
                    </optgroup>
                  )}
                  {options.filter((t) => t.type === 'team').length > 0 && (
                    <optgroup label="Projects">
                      {options.filter((t) => t.type === 'team').map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </Select>
              </div>
              <Button
                disabled={!pick}
                onClick={() => {
                  setShares((current) => [...(current ?? []), { projectId: pick, role: roles[roles.length - 1] }]);
                  setPick('');
                }}
              >
                Add
              </Button>
            </div>
          </div>
        )}
        <div>
          <FieldLabel>Has access</FieldLabel>
          {!shares ? (
            <div className="text-[12px] text-t3">Loading…</div>
          ) : shares.length === 0 ? (
            <div className="rounded-[10px] border border-dashed border-hair px-3 py-3 text-[12px] text-t3">Not shared with anyone yet: only {ownership?.projectName ?? 'its project'} and instance admins have access.</div>
          ) : (
            <div className="overflow-hidden rounded-[10px] border border-hair">
              {shares.map((share) => {
                const target = byId.get(share.projectId);
                const { title, hint, icon: Icon } = describe(target);
                return (
                  <div key={share.projectId} className="flex items-center gap-3 border-b border-hair px-3 py-2 last:border-b-0">
                    <Icon className="size-4 shrink-0 text-t3" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-t1">{title}</span>
                      <span className="block truncate text-[11px] text-t3">{hint}</span>
                    </span>
                    {roles.length > 1 && canShare ? (
                      <div className="w-[120px]">
                        <Select
                          value={share.role}
                          aria-label={`Access for ${title}`}
                          onChange={(e) => setShares((current) => (current ?? []).map((s) => (s.projectId === share.projectId ? { ...s, role: e.target.value as ShareRole } : s)))}
                          className="h-8"
                        >
                          {roles.map((role) => (
                            <option key={role} value={role}>
                              {ROLE_LABEL[role]}
                            </option>
                          ))}
                        </Select>
                      </div>
                    ) : (
                      <span className="text-[12px] text-t2">{ROLE_LABEL[share.role]}</span>
                    )}
                    {canShare && (
                      <Button variant="ghost" size="icon-sm" aria-label={`Stop sharing with ${title}`} onClick={() => setShares((current) => (current ?? []).filter((s) => s.projectId !== share.projectId))}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {ownership && !canShare && <p className="text-[12px] text-t3">Only admins of {ownership.projectName} can change who it is shared with.</p>}
      </div>
    </Dialog>
  );
}

/** "Move to project": change the home project of a workflow, credential, data table or agent (POST `/api/<kind>/<id>/transfer`). */
export function MoveToProjectDialog({ kind, id, name, currentProjectId, onClose, onMoved }: { kind: ResourceKind; id: string; name: string; currentProjectId?: string; onClose: () => void; onMoved?: () => void }) {
  const viewer = useViewer();
  const { projects } = useProjects();
  const [home, setHome] = useState(currentProjectId);
  const choices = writableProjects(projects).filter((p) => p.id !== home);
  const [target, setTarget] = useState('');
  const [carry, setCarry] = useState(true);
  const [moving, setMoving] = useState(false);
  const current = projects?.find((p) => p.id === home);

  // Opened without the current project (the editor's menu): ask the shares route, which reports the ownership.
  useEffect(() => {
    if (currentProjectId || (kind !== 'workflow' && kind !== 'credential')) return;
    api<{ ownership: ResourceOwnership }>(`${RESOURCE_PATH[kind]}/${id}/shares`)
      .then((r) => setHome(r.ownership.projectId))
      .catch(() => {});
  }, [kind, id, currentProjectId]);

  const move = async () => {
    setMoving(true);
    try {
      const options = kind === 'workflow' ? { shareCredentials: carry } : kind === 'credential' ? { keepAccess: carry } : {};
      await api(`${RESOURCE_PATH[kind]}/${id}/transfer`, { method: 'POST', json: { projectId: target, ...options } });
      const to = choices.find((p) => p.id === target);
      toast.success(`Moved “${name}” to ${to ? projectLabel(to, viewer?.id) : 'the project'}`);
      onMoved?.();
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMoving(false);
    }
  };

  return (
    <Dialog
      title={`Move “${name}” to a project`}
      subtitle={current && `Now in ${projectLabel(current, viewer?.id)}`}
      icon={<ArrowRightLeft className="size-4 text-t2" />}
      width={480}
      onClose={onClose}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void move()} loading={moving} disabled={!target}>
            Move
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-[12px] text-t2">The {NOUN[kind]} belongs to one project; its members get the access their role gives them. Its shares stay as they are.</p>
        <div>
          <FieldLabel>Project</FieldLabel>
          <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Project to move to">
            <option value="">{projects ? (choices.length ? 'Choose a project…' : 'No other project you can add to') : 'Loading…'}</option>
            {choices.map((p) => (
              <option key={p.id} value={p.id}>
                {projectLabel(p, viewer?.id)}
              </option>
            ))}
          </Select>
        </div>
        {(kind === 'workflow' || kind === 'credential') && (
          <label className="flex items-start gap-2.5 text-[12px] text-t1">
            <input type="checkbox" checked={carry} onChange={(e) => setCarry(e.target.checked)} className="mt-0.5" />
            <span>
              {kind === 'workflow' ? 'Share the credentials it uses with the new project, so its runs keep working' : `Keep it usable by ${current ? projectLabel(current, viewer?.id) : 'its current project'}, so their workflows keep running`}
              <span className="block text-t3">{kind === 'workflow' ? 'Only credentials you may share go along.' : 'It is shared back to that project as “can use”.'}</span>
            </span>
          </label>
        )}
      </div>
    </Dialog>
  );
}
