'use client';
/**
 * /projects/<id>: four tabs. Overview counts what the project owns (workflows, credentials, data tables, agents), each
 * count opening the global page filtered to the project; Members; Settings (name, the nodes its workflows may use, who
 * approves its publish requests, MCP, variables, delete); Audit log (project admins). An earlier `?tab=` value maps
 * to its new tab (project-tabs.ts). Its folders are on /workflows?project=<id>.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight, ArrowRightLeft, Bot, MoreHorizontal, Plus, KeyRound, Table2, Trash2, UserPlus, Workflow as WorkflowIcon } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { plural } from '@/lib/client/format';
import type { UserView } from '@/lib/shared/auth';
import { PROJECT_ROLES, projectRoleCan, resourceCan, type ResourceKind, type ResourceOwnership, type ProjectDetail, type ProjectRole } from '@/lib/shared/projects';
import type { ProjectMcpView } from '@/lib/shared/mcp';
import { EMPTY_NODE_POLICY, PROJECT_APPROVER_LABELS, type ProjectApprovers, type ProjectSettingsView, type ScopedNodePolicy } from '@/lib/shared/project-policy';
import { ScopedNodeList } from '@/components/governance/scoped-node-list';
import { VariablesSettings } from '@/components/settings/variables-settings';
import { ProjectWorkspaceCard } from './project-workspace-card'; // PC16
import { useViewer } from '@/components/auth/viewer';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { AuditLog } from '@/components/settings/audit-settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, Select, Switch, Textarea } from '@/components/ui/inputs';
import { CredentialDialog } from '@/components/credentials/credential-dialog';
import { CreateTableDialog } from '@/components/data-tables/create-table-dialog';
import { useWorkflowsReadOnly } from '@/lib/client/environment';
import { MenuItem, Popover } from '@/components/ui/popover';
import { MoveToProjectDialog, RESOURCE_PATH } from './share-dialog';
import { DeleteProjectDialog, describeCounts } from './project-dialogs';
import { rememberProject } from './current-project';
import { projectLabel, useProjectStore } from './use-projects';
import { Segmented } from '../ui/segmented';
import { ProjectBriefCard } from './project-brief-card';
import type { ProjectBriefView } from '@/lib/shared/goals';
import { OVERVIEW_KINDS, PROJECT_TABS, projectTab, type ProjectTab } from './project-tabs';

const ROLE_HINT: Record<ProjectRole, string> = {
  admin: 'Manages members, shares and moves its items',
  editor: 'Creates, edits and runs its items',
  viewer: 'Opens its items and their executions',
};

export function ProjectPage({ projectId }: { projectId: string }) {
  const router = useRouter();
  const params = useSearchParams();
  const viewer = useViewer();
  const [project, setProject] = useState<ProjectDetail>();
  const [error, setError] = useState<string>();
  const tab = projectTab(params.get('tab'));

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
  useEffect(() => {
    if (project) rememberProject(project.id);
  }, [project]);

  const setTab = (next: ProjectTab) => router.replace(`/projects/${encodeURIComponent(projectId)}${next === 'overview' ? '' : `?tab=${next}`}`);
  const role = project?.role;

  if (error) {
    return (
      <PageBody width="narrow">
        <Card>
          <EmptyState title="Project not available" hint={error} action={<Link href="/projects" className="text-[13px] text-ac hover:underline">All projects</Link>} />
        </Card>
      </PageBody>
    );
  }

  return (
    <>
      <PageHeader
        back={{ href: '/projects', label: 'Projects' }}
        title={project ? projectLabel(project, viewer?.id) : 'Project'}
        meta={
          project && (
            <>
              <Badge tone={project.type === 'personal' ? 'muted' : 'accent'}>{project.type === 'personal' ? 'Personal' : 'Team'}</Badge>
              {role && <span>Your role: {role}</span>}
              <span>· {plural(project.memberCount, 'member')}</span>
            </>
          )
        }
        actions={project && tab === 'overview' && projectRoleCan.create(project.role) && <NewInProject project={project} onChanged={() => void loadProject()} />}
      />
      <PageBody width="narrow">
        {project?.description && <p className="mb-4 text-[13px] text-t2">{project.description}</p>}
        <Segmented
          label="Project"
          className="mb-4"
          value={tab}
          onChange={setTab}
          options={PROJECT_TABS.filter((t) => t.id !== 'audit' || projectRoleCan.manage(role)).map((t) => ({ value: t.id, label: t.label }))}
        />
        {project && tab === 'overview' && <Overview project={project} onChanged={() => void loadProject()} />}
        {project && tab === 'audit' && projectRoleCan.manage(role) && <AuditLog projectId={project.id} />}
        {project && tab === 'members' && <ProjectSettings section="members" project={project} onChanged={(next) => (next ? setProject(next) : void loadProject())} />}
        {project && tab === 'settings' && (
          <div className="space-y-4">
            <ProjectSettings section="settings" project={project} onChanged={(next) => (next ? setProject(next) : void loadProject())} />
            {/* PC16: */}<ProjectWorkspaceCard projectId={project.id} />
            <Card>
              <div className="mb-3 text-[13px] font-semibold text-t1">Variables</div>
              <VariablesSettings projectId={project.id} />
            </Card>
          </div>
        )}
      </PageBody>
    </>
  );
}

const ICON: Record<string, typeof WorkflowIcon> = { workflow: WorkflowIcon, credential: KeyRound, dataTable: Table2, agent: Bot };

/** Header "New ▾": a workflow, credential, data table or agent made in this project. */
function NewInProject({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'credential' | 'table'>();
  const [busy, setBusy] = useState(false);
  const readOnly = useWorkflowsReadOnly();
  const [tableNames, setTableNames] = useState<string[]>([]);
  const openTable = () => {
    api<{ tables: { name: string }[] }>(`/api/data-tables?projectId=${encodeURIComponent(project.id)}`)
      .then((r) => setTableNames((r.tables ?? []).map((t) => t.name)))
      .catch(() => undefined)
      .finally(() => setDialog('table'));
  };
  const make = async (kind: 'workflow' | 'agent') => {
    setBusy(true);
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
      setBusy(false);
    }
  };
  return (
    <>
      <Popover
        trigger={({ toggle }) => (
          <Button variant="primary" size="sm" onClick={toggle} loading={busy}>
            {!busy && <Plus className="size-3.5" />} New
          </Button>
        )}
      >
        {(close) => (
          <>
            <MenuItem disabled={!!readOnly} hint={readOnly} onClick={() => { close(); void make('workflow'); }}><WorkflowIcon /> Workflow</MenuItem>
            <MenuItem onClick={() => { close(); setDialog('credential'); }}><KeyRound /> Credential</MenuItem>
            <MenuItem onClick={() => { close(); openTable(); }}><Table2 /> Data table</MenuItem>
            <MenuItem onClick={() => { close(); void make('agent'); }}><Bot /> Agent</MenuItem>
          </>
        )}
      </Popover>
      {dialog === 'credential' && <CredentialDialog projectId={project.id} onClose={() => setDialog(undefined)} onSaved={onChanged} />}
      {dialog === 'table' && <CreateTableDialog projectId={project.id} existingNames={tableNames} onClose={() => { setDialog(undefined); onChanged(); }} />}
    </>
  );
}

type OwnedItem = { id: string; name: string; ownership?: ResourceOwnership };
const OWNED: Array<{ kind: 'dataTable' | 'agent'; title: string; href: (id: string) => string }> = [
  { kind: 'dataTable', title: 'Data tables', href: (id) => `/data-tables/${id}` },
  { kind: 'agent', title: 'Agents', href: (id) => `/agents/${id}` },
];

/** What the project owns, by kind: each count opens the global page for it; data tables and agents also list here with Move to project. */
function Overview({ project, onChanged }: { project: ProjectDetail; onChanged: () => void }) {
  return (
    <div className="space-y-4">
      <ProjectBriefCard projectId={project.id} brief={(project as ProjectDetail & { brief?: ProjectBriefView }).brief} onChanged={onChanged} />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {OVERVIEW_KINDS.map(({ kind, label, href }) => {
          const Icon = ICON[kind];
          const count = project.counts?.[kind] ?? 0;
          return (
            <Link key={kind} href={href(project.id)} className="group flex items-center gap-3.5 rounded-2xl border border-hair bg-sf px-4 py-4 transition-colors hover:border-ac">
              <span className="grid size-9 shrink-0 place-items-center rounded-[10px] border border-hair bg-wl text-t2">
                <Icon className="size-4" strokeWidth={1.7} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[22px] font-semibold leading-none tabular-nums text-t1">{count}</span>
                <span className="mt-1 block text-[12px] text-t3">{label}</span>
              </span>
              <ArrowRight className="size-4 shrink-0 text-t3 transition-colors group-hover:text-ac" />
            </Link>
          );
        })}
      </div>
      {OWNED.map((o) => (
        <OwnedList key={o.kind} project={project} {...o} onChanged={onChanged} />
      ))}
    </div>
  );
}

/** The data tables or agents the project owns, each with its Move to project menu (their global lists have none). */
function OwnedList({ project, kind, title, href, onChanged }: { project: ProjectDetail; kind: ResourceKind; title: string; href: (id: string) => string; onChanged: () => void }) {
  const [items, setItems] = useState<OwnedItem[]>();
  const [moving, setMoving] = useState<OwnedItem>();
  const k = kind === 'dataTable' ? 'tables' : 'agents';
  const load = useCallback(
    () =>
      api<Record<string, OwnedItem[]>>(`${RESOURCE_PATH[kind]}?projectId=${encodeURIComponent(project.id)}`)
        .then((r) => setItems(r[k] ?? []))
        .catch((e: Error) => toast.error(e.message)),
    [kind, k, project.id],
  );
  useEffect(() => {
    void load();
  }, [load]);
  const sorted = useMemo(() => [...(items ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [items]);
  if (!sorted.length) return null;
  return (
    <div>
      <div className="mb-2 text-[12px] font-semibold text-t2">{title}</div>
      <div className="overflow-hidden rounded-2xl border border-hair bg-sf">
        {sorted.map((item) => (
          <div key={item.id} className="group flex items-center border-b border-hair last:border-b-0 hover:bg-acdim">
            <Link href={href(item.id)} className="min-w-0 flex-1 truncate px-4 py-2.5 text-[13px] font-semibold text-t1">
              {item.name}
            </Link>
            {resourceCan(item.ownership?.access, 'move') && (
              <div className="pr-2.5">
                <Popover
                  trigger={({ toggle }) => (
                    <Button variant="ghost" size="icon-sm" onClick={toggle} aria-label={`${item.name} menu`} className="text-t3">
                      <MoreHorizontal className="size-4" />
                    </Button>
                  )}
                >
                  {(close) => (
                    <MenuItem onClick={() => { close(); setMoving(item); }}>
                      <ArrowRightLeft /> Move to project…
                    </MenuItem>
                  )}
                </Popover>
              </div>
            )}
          </div>
        ))}
      </div>
      {moving && (
        <MoveToProjectDialog
          kind={kind}
          id={moving.id}
          name={moving.name}
          currentProjectId={moving.ownership?.projectId}
          onClose={() => setMoving(undefined)}
          onMoved={() => {
            void load();
            onChanged();
            void useProjectStore.getState().refresh();
          }}
        />
      )}
    </div>
  );
}

/** The members tab (`section="members"`: who is in the project) or the settings tab (name, governance, MCP, delete). */
function ProjectSettings({ project, section, onChanged }: { project: ProjectDetail; section: 'members' | 'settings'; onChanged: (next?: ProjectDetail) => void }) {
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
    return section === 'members' ? (
      <Card>
        <p className="text-[13px] text-t1">A personal project belongs to {project.ownerId === viewer?.id ? 'you' : project.name} and has no other members.</p>
        <p className="mt-1 text-[12px] text-t3">To work with others, share workflows and credentials with them, or move them to a team project.</p>
      </Card>
    ) : (
      <div className="space-y-4">
        <GovernanceCard project={project} />
        <McpCard project={project} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {section === 'settings' && manage && (
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

      {section === 'members' && (
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
      )}

      {section === 'settings' && <GovernanceCard project={project} />}

      {section === 'settings' && <McpCard project={project} />}

      {section === 'settings' && manage && (
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

/** The project's own MCP server (the instance MCP server scoped to it, lib/server/mcp/project-servers.ts) and its gateway route. */
function McpCard({ project }: { project: ProjectDetail }) {
  const [view, setView] = useState<ProjectMcpView>();
  const [saving, setSaving] = useState(false);
  const base = `/api/projects/${encodeURIComponent(project.id)}/mcp`;
  useEffect(() => {
    api<ProjectMcpView>(base)
      .then(setView)
      .catch((e: Error) => toast.error(e.message));
  }, [base]);
  if (!view) return <Card className="h-24 animate-pulse-soft">{null}</Card>;
  const toggle = async (gateway: boolean) => {
    setSaving(true);
    try {
      setView(await api<ProjectMcpView>(base, { method: 'PATCH', json: { gateway } }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card className="space-y-3">
      <div>
        <div className="text-[13px] font-semibold text-t1">MCP server</div>
        <p className="text-[12px] text-t3">
          The instance MCP server (Settings → MCP) limited to this project: coding agents list, change and run only this project’s workflows, and what they create goes into it. Connect to{' '}
          <code className="font-mono text-[12px] text-t1" data-testid="project-mcp-path">
            {view.path}
          </code>{' '}
          with the instance access token, or use a Landflow MCP token made for this project.
          {!view.instanceEnabled && ' The instance MCP server is off, so it answers nothing yet.'}
        </p>
      </div>
      <div className="flex items-start gap-2">
        <Switch checked={view.gateway} onChange={(on) => void toggle(on)} disabled={!view.canEdit || saving} label="Register on the MCP gateway" />
        <div>
          <div className="text-[13px] font-semibold text-t1">Register on the MCP gateway</div>
          <p className="text-[12px] text-t3">
            The gateway sync adds a route for this project’s server{view.gatewayPath ? <> at <code className="font-mono text-[12px] text-t1">{view.gatewayPath}</code></> : ''} (signed-in agents act as themselves, within this project).
          </p>
        </div>
      </div>
      {!view.canEdit && <p className="text-[12px] text-t3">The project’s admins change this.</p>}
    </Card>
  );
}

const APPROVER_HINT: Record<ProjectApprovers, string> = {
  default: 'Whoever the instance’s four-eyes setting names approves.',
  admins: 'Admins of this project approve its publish requests (and instance owners and admins).',
  editors: 'Its admins and editors approve (and instance owners and admins).',
  instance: 'Only instance owners and admins approve, not the project’s members.',
};

/**
 * The project's governance (lib/server/governance/scopes.ts): an allow-list of the nodes its workflows may use, under
 * the instance's rules, and who approves its publish requests when four-eyes publishing applies.
 */
function GovernanceCard({ project }: { project: ProjectDetail }) {
  const [view, setView] = useState<ProjectSettingsView>();
  const [nodes, setNodes] = useState<ScopedNodePolicy>(EMPTY_NODE_POLICY);
  const [approvers, setApprovers] = useState<ProjectApprovers>('default');
  const [fourEyes, setFourEyes] = useState(false);
  const [brainPayloads, setBrainPayloads] = useState(false);
  const [saving, setSaving] = useState(false);
  const [version, setVersion] = useState(0);
  const base = `/api/projects/${encodeURIComponent(project.id)}/settings`;
  const show = (next: ProjectSettingsView) => {
    setView(next);
    setNodes(next.settings.nodes);
    setApprovers(next.settings.approvers);
    setFourEyes(next.settings.fourEyes);
    setBrainPayloads(next.settings.brainPayloads ?? false);
    setVersion((v) => v + 1);
  };
  useEffect(() => {
    api<ProjectSettingsView>(base)
      .then(show)
      .catch((e: Error) => toast.error(e.message));
  }, [base]);
  if (!view) return <Card className="h-24 animate-pulse-soft">{null}</Card>;
  const editable = view.canEdit;
  const dirty = JSON.stringify({ nodes, approvers, fourEyes, brainPayloads }) !==
    JSON.stringify({ nodes: view.settings.nodes, approvers: view.settings.approvers, fourEyes: view.settings.fourEyes, brainPayloads: view.settings.brainPayloads ?? false });
  const save = async () => {
    setSaving(true);
    try {
      show(await api<ProjectSettingsView>(base, { method: 'PATCH', json: { nodes, approvers, fourEyes, brainPayloads } }));
      toast.success('Project governance saved');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-4">
      <div>
        <div className="text-[13px] font-semibold text-t1">Allowed nodes</div>
        <p className="text-[12px] text-t3">
          The node types this project’s workflows and agents may use, on top of the instance’s rules (Settings → Governance). Nodes not on the list are hidden from the node picker, flagged when
          saving, refused at publish and fail when a run reaches them.
        </p>
      </div>
      <ScopedNodeList key={version} value={nodes} onChange={setNodes} catalog={view} disabled={!editable} offLabel="Everything the instance allows" allowLabel="Only these" />
      <div className="flex items-start gap-2">
        <Switch checked={fourEyes} onChange={setFourEyes} disabled={!editable} label="Four-eyes for this project’s workflows" />
        <div>
          <div className="text-[13px] font-semibold text-t1">Four-eyes for this project’s workflows</div>
          <p className="text-[12px] text-t3">Publishing, rolling back and promoting its workflows to another environment need someone else’s approval, even when the instance doesn’t ask for it. Who approves follows the setting below.</p>
        </div>
      </div>
      <div className="flex items-start gap-2">
        <Switch checked={brainPayloads} onChange={setBrainPayloads} disabled={!editable} label="Let the second brain read run data" />
        <div>
          <div className="text-[13px] font-semibold text-t1">Let the second brain read run data</div>
          <p className="text-[12px] text-t3">Off: it studies metadata only (counts, durations, error messages with values removed). On: it may read a failed run’s input and output to write a fix.</p>
        </div>
      </div>
      {project.type === 'team' && (
        <div>
          <FieldLabel>Who approves publish requests</FieldLabel>
          <div className="max-w-[360px]">
            <Select value={approvers} onChange={(e) => setApprovers(e.target.value as ProjectApprovers)} disabled={!editable} aria-label="Who approves publish requests">
              {(Object.keys(PROJECT_APPROVER_LABELS) as ProjectApprovers[]).map((id) => (
                <option key={id} value={id}>
                  {PROJECT_APPROVER_LABELS[id]}
                </option>
              ))}
            </Select>
          </div>
          <p className="mt-1 text-[12px] text-t3">{APPROVER_HINT[approvers]} Never the person who asked. Applies when four-eyes publishing is on for the instance or the workflow.</p>
        </div>
      )}
      {!editable && <p className="text-[12px] text-t3">The project’s admins change these.</p>}
      {editable && dirty && (
        <div className="flex justify-end gap-2 border-t border-hair pt-3">
          <Button size="sm" variant="ghost" onClick={() => show(view)}>
            Discard
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}
