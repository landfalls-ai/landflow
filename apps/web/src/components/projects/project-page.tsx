'use client';
/**
 * /projects/<id>: what a project owns and what is shared with it, by kind (workflows, credentials, data tables,
 * agents), creating things in it, and its settings (name, members and roles, delete). Each item's menu has Share and
 * "Move to project" when the viewer may (lib/shared/projects.ts `resourceCan`).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRightLeft, Bot, KeyRound, MoreHorizontal, Plus, Share2, Table2, Trash2, UserPlus, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { UserView } from '@/lib/shared/auth';
import { PROJECT_ROLES, projectRoleCan, resourceCan, type ProjectDetail, type ProjectRole, type ResourceKind, type ResourceOwnership } from '@/lib/shared/projects';
import { useViewer } from '@/components/auth/viewer';
import { CredentialDialog, CredentialTypeIcon } from '@/components/credentials/credential-dialog';
import { useCredentials } from '@/components/credentials/use-credentials';
import { CreateTableDialog } from '@/components/data-tables/create-table-dialog';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, Select, Textarea } from '@/components/ui/inputs';
import { MenuItem, Popover } from '@/components/ui/popover';
import { DeleteProjectDialog, describeCounts } from './project-dialogs';
import { MoveToProjectDialog, RESOURCE_PATH, ShareDialog } from './share-dialog';
import { projectLabel, useProjectStore } from './use-projects';

type Tab = 'workflows' | 'credentials' | 'dataTables' | 'agents' | 'settings';
const TABS: Array<{ id: Tab; label: string; kind?: ResourceKind }> = [
  { id: 'workflows', label: 'Workflows', kind: 'workflow' },
  { id: 'credentials', label: 'Credentials', kind: 'credential' },
  { id: 'dataTables', label: 'Data tables', kind: 'dataTable' },
  { id: 'agents', label: 'Agents', kind: 'agent' },
  { id: 'settings', label: 'Settings' },
];
const ROLE_HINT: Record<ProjectRole, string> = {
  admin: 'Manages members, shares and moves its items',
  editor: 'Creates, edits and runs its items',
  viewer: 'Opens its items and their executions',
};

/** An item of any kind as the list routes return it (with `ownership`). */
interface Item {
  id: string;
  name: string;
  updatedAt?: string;
  ownership?: ResourceOwnership;
  type?: string;
  active?: boolean;
}

export function ProjectPage({ projectId }: { projectId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const viewer = useViewer();
  const [project, setProject] = useState<ProjectDetail>();
  const [error, setError] = useState<string>();
  const tab = (TABS.find((t) => t.id === params.get('tab'))?.id ?? 'workflows') as Tab;

  const loadProject = useCallback(
    () =>
      api<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(projectId)}`)
        .then((r) => setProject(r.project))
        .catch((e: Error) => setError(e.message)),
    [projectId],
  );
  useEffect(() => {
    void loadProject();
  }, [loadProject]);

  const setTab = (next: Tab) => router.replace(`/projects/${encodeURIComponent(projectId)}${next === 'workflows' ? '' : `?tab=${next}`}`);
  const role = project?.role;

  if (error) {
    return (
      <PageBody className="max-w-[980px]">
        <Card>
          <EmptyState title="Project not available" hint={error} action={<Link href="/projects" className="text-[13px] text-ac hover:underline">All projects</Link>} />
        </Card>
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        title={project ? projectLabel(project, viewer?.id) : 'Project'}
        meta={
          project && (
            <>
              <Badge tone={project.type === 'personal' ? 'muted' : 'accent'}>{project.type === 'personal' ? 'Personal' : 'Team'}</Badge>
              {role && <span>Your role: {role}</span>}
              <span>· {project.memberCount} {project.memberCount === 1 ? 'member' : 'members'}</span>
            </>
          )
        }
      />
      <PageBody className="max-w-[980px]">
        {project?.description && <p className="mb-4 text-[13px] text-t2">{project.description}</p>}
        <div role="tablist" className="mb-4 flex w-fit items-center gap-0.5 rounded-full border border-hair bg-sf2 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={t.id === tab}
              onClick={() => setTab(t.id)}
              className={cn('h-7 rounded-full px-3.5 text-[13px] text-t2 transition-all duration-200 hover:text-t1', t.id === tab && 'bg-sf font-semibold text-t1 shadow-[0_1px_3px_rgba(0,0,0,0.08),0_0_0_1px_var(--hair)]')}
            >
              {t.label}
              {t.kind && project?.counts?.[t.kind] ? <span className="ml-1.5 font-mono text-[11px] font-normal text-t3">{project.counts[t.kind]}</span> : null}
            </button>
          ))}
        </div>
        {project && tab !== 'settings' && <ResourceList key={tab} project={project} kind={TABS.find((t) => t.id === tab)!.kind!} onChanged={() => void loadProject()} />}
        {project && tab === 'settings' && <ProjectSettings project={project} onChanged={(next) => (next ? setProject(next) : void loadProject())} />}
      </PageBody>
    </>
  );
}

const LIST_KEY: Record<ResourceKind, string> = { workflow: 'workflows', credential: 'credentials', dataTable: 'tables', agent: 'agents' };
const HREF: Partial<Record<ResourceKind, (id: string) => string>> = { workflow: (id) => `/workflows/${id}`, dataTable: (id) => `/data-tables/${id}`, agent: (id) => `/agents/${id}` };
const ICON: Record<ResourceKind, typeof WorkflowIcon> = { workflow: WorkflowIcon, credential: KeyRound, dataTable: Table2, agent: Bot };
const EMPTY: Record<ResourceKind, string> = {
  workflow: 'No workflows in this project yet.',
  credential: 'No credentials in this project yet. Credentials shared with the project show here too; its workflows can use them.',
  dataTable: 'No data tables in this project yet.',
  agent: 'No agents in this project yet.',
};

function ResourceList({ project, kind, onChanged }: { project: ProjectDetail; kind: ResourceKind; onChanged: () => void }) {
  const router = useRouter();
  const { types } = useCredentials();
  const [items, setItems] = useState<Item[]>();
  const [dialog, setDialog] = useState<{ kind: 'share' | 'move'; item: Item } | { kind: 'credential'; id?: string } | { kind: 'table' }>();
  const [creating, setCreating] = useState(false);
  const canCreate = projectRoleCan.create(project.role);

  const load = useCallback(
    () =>
      api<Record<string, Item[]>>(`${RESOURCE_PATH[kind]}?projectId=${encodeURIComponent(project.id)}`)
        .then((r) => setItems(r[LIST_KEY[kind]] ?? []))
        .catch((e: Error) => toast.error(e.message)),
    [kind, project.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const changed = () => {
    void load();
    onChanged();
    void useProjectStore.getState().refresh();
  };

  const create = async () => {
    if (kind === 'credential') return setDialog({ kind: 'credential' });
    if (kind === 'dataTable') return setDialog({ kind: 'table' });
    setCreating(true);
    try {
      const query = `?projectId=${encodeURIComponent(project.id)}`;
      if (kind === 'workflow') {
        const { workflow } = await api<{ workflow: { id: string } }>(`/api/workflows${query}`, { method: 'POST', json: { name: 'Untitled workflow', nodes: [], connections: [] } });
        router.push(`/workflows/${workflow.id}`);
      } else {
        const { agent } = await api<{ agent: { id: string } }>(`/api/agents${query}`, { method: 'POST', json: {} });
        router.push(`/agents/${agent.id}`);
      }
    } catch (e) {
      toast.error((e as Error).message);
      setCreating(false);
    }
  };
  const sorted = useMemo(() => [...(items ?? [])].sort((a, b) => Number(Boolean(a.ownership?.shared)) - Number(Boolean(b.ownership?.shared)) || a.name.localeCompare(b.name)), [items]);
  const Icon = ICON[kind];
  const noun = { workflow: 'workflow', credential: 'credential', dataTable: 'data table', agent: 'agent' }[kind];

  return (
    <>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[12px] text-t3">{items ? `${items.length} ${items.length === 1 ? noun : `${noun}s`}` : 'Loading…'}</span>
        {canCreate && (
          <Button variant="primary" size="sm" className="ml-auto" onClick={() => void create()} loading={creating}>
            <Plus className="size-3.5" /> New {noun}
          </Button>
        )}
      </div>
      {items && items.length === 0 ? (
        <Card>
          <EmptyState compact title={EMPTY[kind]} />
        </Card>
      ) : (
        <div className="overflow-hidden rounded-2xl border border-hair bg-sf">
          {sorted.map((item) => {
            const access = item.ownership?.access;
            const sharedIn = item.ownership && item.ownership.projectId !== project.id;
            const info = kind === 'credential' ? types?.find((t) => t.type === item.type) : undefined;
            const href = HREF[kind]?.(item.id);
            const body = (
              <>
                {kind === 'credential' ? <CredentialTypeIcon info={info} size={28} /> : <Icon className="size-4 shrink-0 text-t3" strokeWidth={1.7} />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-t1">{item.name}</span>
                  <span className="block truncate text-[12px] text-t3">
                    {sharedIn ? `Shared from ${item.ownership!.projectName}` : kind === 'credential' ? (info?.descriptor.displayName ?? item.type) : 'Owned by this project'}
                  </span>
                </span>
                {sharedIn && <Badge tone="muted">{access?.role === 'user' ? 'can use' : access?.role === 'viewer' ? 'can view' : 'can edit'}</Badge>}
                {item.active && <Badge tone="success">Published</Badge>}
                {item.updatedAt && <span className="w-24 shrink-0 text-right text-[12px] text-t3">{timeAgo(item.updatedAt)}</span>}
              </>
            );
            const rowClass = 'flex min-w-0 flex-1 items-center gap-3 px-4 py-2.5 text-left';
            return (
              <div key={item.id} className="group flex items-center border-b border-hair transition-colors last:border-b-0 hover:bg-acdim">
                {href ? (
                  <Link href={href} className={rowClass}>
                    {body}
                  </Link>
                ) : (
                  <button className={rowClass} onClick={() => (resourceCan(access, 'update') ? setDialog({ kind: 'credential', id: item.id }) : toast.info('Shared for use in workflows: its settings stay hidden'))}>
                    {body}
                  </button>
                )}
                <ItemMenu kind={kind} item={item} onShare={() => setDialog({ kind: 'share', item })} onMove={() => setDialog({ kind: 'move', item })} />
              </div>
            );
          })}
        </div>
      )}
      {dialog?.kind === 'share' && (kind === 'workflow' || kind === 'credential') && <ShareDialog kind={kind} id={dialog.item.id} name={dialog.item.name} onClose={() => setDialog(undefined)} onChanged={changed} />}
      {dialog?.kind === 'move' && <MoveToProjectDialog kind={kind} id={dialog.item.id} name={dialog.item.name} currentProjectId={dialog.item.ownership?.projectId} onClose={() => setDialog(undefined)} onMoved={changed} />}
      {dialog?.kind === 'credential' && <CredentialDialog credentialId={dialog.id} projectId={project.id} onClose={() => setDialog(undefined)} onSaved={changed} />}
      {dialog?.kind === 'table' && <CreateTableDialog projectId={project.id} existingNames={(items ?? []).map((t) => t.name)} onClose={() => setDialog(undefined)} />}
    </>
  );
}

function ItemMenu({ kind, item, onShare, onMove }: { kind: ResourceKind; item: Item; onShare: () => void; onMove: () => void }) {
  const access = item.ownership?.access;
  const shareable = kind === 'workflow' || kind === 'credential';
  const canMove = resourceCan(access, 'move');
  if (!shareable && !canMove) return <div className="w-10" />;
  return (
    <div className="pl-2 pr-2.5">
      <Popover
        trigger={({ open, toggle }) => (
          <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={`${item.name} menu`} className={cn('text-t3 opacity-0 focus-visible:opacity-100 group-hover:opacity-100', open && 'opacity-100')}>
            <MoreHorizontal className="size-4" />
          </Button>
        )}
      >
        {(close) => (
          <>
            {shareable && (
              <MenuItem
                onClick={() => {
                  close();
                  onShare();
                }}
              >
                <Share2 /> {resourceCan(access, 'share') ? 'Share…' : 'Who has access…'}
              </MenuItem>
            )}
            {canMove && (
              <MenuItem
                onClick={() => {
                  close();
                  onMove();
                }}
              >
                <ArrowRightLeft /> Move to project…
              </MenuItem>
            )}
          </>
        )}
      </Popover>
    </div>
  );
}

function ProjectSettings({ project, onChanged }: { project: ProjectDetail; onChanged: (next?: ProjectDetail) => void }) {
  const router = useRouter();
  const viewer = useViewer();
  const manage = projectRoleCan.manage(project.role);
  const team = project.type === 'team';
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? '');
  const [members, setMembers] = useState(project.members.map((m) => ({ userId: m.userId, role: m.role })));
  const [users, setUsers] = useState<UserView[]>([]);
  const [pick, setPick] = useState('');
  const [saving, setSaving] = useState<'details' | 'members'>();
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (manage && team) api<{ users: UserView[] }>('/api/users').then((r) => setUsers(r.users)).catch(() => {});
  }, [manage, team]);
  useEffect(() => setMembers(project.members.map((m) => ({ userId: m.userId, role: m.role }))), [project.members]);

  const byId = new Map(project.members.map((m) => [m.userId, m]));
  const userOf = (id: string) => byId.get(id) ?? users.find((u) => u.id === id);
  const dirty = JSON.stringify(members) !== JSON.stringify(project.members.map((m) => ({ userId: m.userId, role: m.role })));

  const saveDetails = async () => {
    setSaving('details');
    try {
      const { project: next } = await api<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', json: { name: name.trim(), description: description.trim() || null } });
      onChanged(next);
      void useProjectStore.getState().refresh();
      toast.success('Saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(undefined);
    }
  };
  const saveMembers = async () => {
    setSaving('members');
    try {
      const { project: next } = await api<{ project: ProjectDetail }>(`/api/projects/${encodeURIComponent(project.id)}/members`, { method: 'PUT', json: { members } });
      onChanged(next);
      void useProjectStore.getState().refresh();
      toast.success('Members saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(undefined);
    }
  };

  if (!team) {
    return (
      <Card>
        <p className="text-[13px] text-t1">A personal project belongs to {project.ownerId === viewer?.id ? 'you' : project.name} and has no other members.</p>
        <p className="mt-1 text-[12px] text-t3">To work with others, share workflows and credentials with them, or move them to a team project.</p>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {manage && (
        <Card className="space-y-3">
          <div>
            <FieldLabel>Name</FieldLabel>
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} />
          </div>
          <div>
            <FieldLabel>Description</FieldLabel>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
          </div>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" onClick={() => void saveDetails()} loading={saving === 'details'} disabled={!name.trim() || (name === project.name && description === (project.description ?? ''))}>
              Save
            </Button>
          </div>
        </Card>
      )}

      <Card>
        <div className="mb-3 flex items-center gap-2">
          <span className="text-[13px] font-semibold text-t1">Members</span>
          <span className="text-[12px] text-t3">Instance owners and admins can open every project.</span>
        </div>
        {manage && (
          <div className="mb-3 flex gap-2">
            <div className="min-w-0 flex-1">
              <Select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add a member">
                <option value="">Add a member…</option>
                {users
                  .filter((u) => !members.some((m) => m.userId === u.id))
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name} · {u.email}
                    </option>
                  ))}
              </Select>
            </div>
            <Button
              disabled={!pick}
              onClick={() => {
                setMembers((current) => [...current, { userId: pick, role: 'editor' }]);
                setPick('');
              }}
            >
              <UserPlus className="size-3.5" /> Add
            </Button>
          </div>
        )}
        {members.length === 0 ? (
          <p className="text-[12px] text-t3">No members yet.</p>
        ) : (
          <div className="overflow-hidden rounded-[10px] border border-hair">
            {members.map((member) => {
              const user = userOf(member.userId);
              const source = byId.get(member.userId)?.source;
              return (
                <div key={member.userId} className="flex items-center gap-3 border-b border-hair px-3 py-2 last:border-b-0">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-t1">
                      {user?.name ?? member.userId}
                      {member.userId === viewer?.id && <span className="text-t3"> (you)</span>}
                    </span>
                    <span className="block truncate text-[11px] text-t3">{user?.email}</span>
                  </span>
                  {source && source !== 'manual' && <Badge tone="muted" title="Kept in sync by single sign-on or provisioning">{source.toUpperCase()}</Badge>}
                  {manage ? (
                    <div className="w-[130px]">
                      <Select className="h-8" value={member.role} aria-label={`Role of ${user?.name ?? member.userId}`} title={ROLE_HINT[member.role]} onChange={(e) => setMembers((current) => current.map((m) => (m.userId === member.userId ? { ...m, role: e.target.value as ProjectRole } : m)))}>
                        {PROJECT_ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r[0].toUpperCase() + r.slice(1)}
                          </option>
                        ))}
                      </Select>
                    </div>
                  ) : (
                    <span className="text-[12px] capitalize text-t2" title={ROLE_HINT[member.role]}>
                      {member.role}
                    </span>
                  )}
                  {manage && (
                    <Button variant="ghost" size="icon-sm" aria-label={`Remove ${user?.name ?? member.userId}`} onClick={() => setMembers((current) => current.filter((m) => m.userId !== member.userId))}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        <p className="mt-2 text-[12px] text-t3">
          Admins: {ROLE_HINT.admin.toLowerCase()}. Editors: {ROLE_HINT.editor.toLowerCase()}. Viewers: {ROLE_HINT.viewer.toLowerCase()}.
        </p>
        {manage && dirty && (
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setMembers(project.members.map((m) => ({ userId: m.userId, role: m.role })))}>
              Discard
            </Button>
            <Button size="sm" variant="primary" onClick={() => void saveMembers()} loading={saving === 'members'}>
              Save members
            </Button>
          </div>
        )}
      </Card>

      {manage && (
        <Card className="flex items-center gap-3 border-rdbd">
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold text-t1">Delete this project</span>
            <span className="block text-[12px] text-t3">{describeCounts(project.counts) ? `What it owns (${describeCounts(project.counts)}) moves to a project you choose.` : 'It owns nothing.'}</span>
          </span>
          <Button variant="danger" size="sm" onClick={() => setDeleting(true)}>
            Delete project
          </Button>
        </Card>
      )}
      {deleting && <DeleteProjectDialog project={project} onClose={() => setDeleting(false)} onDeleted={() => router.push('/projects')} />}
    </div>
  );
}
