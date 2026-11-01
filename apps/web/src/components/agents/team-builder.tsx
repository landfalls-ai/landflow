'use client';
/**
 * A team's page (docs/agent-teams.md): its name and goal, the org chart as an indented tree of member cards (one column, so it
 * reads on a phone), what stops it from being published, and Publish. Every change to the draft autosaves after a pause.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Check, LayoutTemplate, Package, Workflow, Plus, RadioTower, TriangleAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { defaultParameters, isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import { api, ApiError } from '@/lib/client/api';
import type { AgentSummary } from '@/lib/shared/agents';
import { formatTokens } from '@/lib/shared/ai-usage';
import { managerOf, memberAgent, orgTree, reportsOf, teamIssues, type AgentTeam, type AgentTeamConfig, type OrgNode, type TeamMember } from '@/lib/shared/agent-teams';
import { cn } from '@/lib/utils';
import { NodeCredentials } from '../credentials/node-credentials';
import { ParamForm } from '../editor/param-form';
import { PageBody, PageHeader } from '../shell/page-header';
import { Badge, Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { Input, Select, Textarea } from '../ui/inputs';
import { A2A_AGENT, A2aTile } from './a2a-agent-dialog';
import { AgentAvatar } from './avatar';
import { Dialog, Field } from './dialog';
import { ExportPluginDialog } from './export-plugin-dialog';
import { NotebookTab } from './notebook-tab';
import { SaveTeamTemplateDialog } from './save-team-template-dialog';
import { useAgentList, useNodeTypes } from './use-agent-data';
import { BudgetBar } from '../editor/team-live';
import type { TeamMoment } from '@/lib/shared/team-progress';
import { faceOf } from './faces';
import { ConsultLines } from './consult-lines';
import { newId } from './util';

/** The A2A Agent node's parameters that describe the remote agent (as in the agent builder's A2A dialog). */
const SERVER_PROPERTIES = new Set(['agentUrl', 'authentication', 'options']);

type SaveState = 'saved' | 'pending' | 'saving' | 'error';

/** Everyone below `id`, so a member can't be asked to report to its own reports. */
function below(config: AgentTeamConfig, id: string): Set<string> {
  const out = new Set<string>();
  const walk = (at: string) => reportsOf(config, at).forEach((m) => !out.has(m.id) && (out.add(m.id), walk(m.id)));
  walk(id);
  return out;
}

export function TeamBuilder({ teamId }: { teamId: string }) {
  const router = useRouter();
  const agents = useAgentList();
  const [team, setTeam] = useState<AgentTeam>();
  const [draft, setDraft] = useState<AgentTeamConfig>();
  const [loadError, setLoadError] = useState<string>();
  const [save, setSave] = useState<SaveState>('saved');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ member?: TeamMember; reportsTo?: string }>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [saveTemplate, setSaveTemplate] = useState(false);
  const params = useSearchParams();
  const fromTemplate = params.get('flow');
  // The page has two tabs: the chart (members, last run, flows, publishing) and the team's notebook (docs/team-notebook.md).
  const tab = params.get('tab') === 'notebook' ? 'notebook' : 'chart';
  const showTab = (next: 'chart' | 'notebook') => {
    const q = new URLSearchParams(params.toString());
    if (next === 'chart') q.delete('tab');
    else q.set('tab', next);
    router.replace(q.size ? `?${q}` : `/agents/teams/${teamId}`, { scroll: false });
  };
  const [noteTotal, setNoteTotal] = useState<number>();
  useEffect(() => {
    api<{ counts: { total: number } }>(`/api/agent-teams/${teamId}/notes?scope=team`)
      .then((r) => setNoteTotal(r.counts.total))
      .catch(() => setNoteTotal(undefined));
  }, [teamId, tab]);
  // The flows that run this team (a template made one, or you did): links to them.
  const [flows, setFlows] = useState<Array<{ id: string; name: string; active: boolean }>>([]);
  useEffect(() => {
    api<{ flows: Array<{ id: string; name: string; active: boolean }> }>(`/api/agent-teams/${teamId}/flows`)
      .then((r) => setFlows(r.flows))
      .catch(() => setFlows([]));
  }, [teamId]);

  const latest = useRef<AgentTeamConfig>(undefined);
  const dirty = useRef(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const queue = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    api<{ team: AgentTeam }>(`/api/agent-teams/${teamId}`)
      .then(({ team }) => {
        setTeam(team);
        latest.current = team.draft;
        setDraft(team.draft);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [teamId]);

  const persist = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    if (!dirty.current || !latest.current) return queue.current;
    dirty.current = false;
    const body = latest.current;
    setSave('saving');
    queue.current = queue.current.then(async () => {
      try {
        const r = await api<{ team: AgentTeam }>(`/api/agent-teams/${teamId}`, { method: 'PUT', json: body });
        setTeam(r.team);
        if (!dirty.current) setSave('saved');
      } catch (e) {
        dirty.current = true;
        setSave('error');
        toast.error(`Could not save the team: ${(e as Error).message}`);
      }
    });
    return queue.current;
  }, [teamId]);

  const update = useCallback(
    (fn: (config: AgentTeamConfig) => AgentTeamConfig) => {
      if (!latest.current) return;
      const next = fn(latest.current);
      latest.current = next;
      setDraft(next);
      dirty.current = true;
      setSave('pending');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => void persist(), 600);
    },
    [persist],
  );

  // Leaving the page saves what's pending.
  useEffect(
    () => () => {
      if (!dirty.current || !latest.current) return;
      void fetch(`/api/agent-teams/${teamId}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(latest.current), keepalive: true });
    },
    [teamId],
  );

  const issues = useMemo(() => (draft ? teamIssues(draft) : []), [draft]);
  const tree = useMemo(() => (draft ? orgTree(draft) : undefined), [draft]);
  const loose = useMemo(() => {
    if (!draft) return [];
    const seen = new Set<string>();
    const walk = (n?: OrgNode) => n && (seen.add(n.member.id), n.reports.forEach(walk));
    walk(tree);
    return draft.members.filter((m) => !seen.has(m.id));
  }, [draft, tree]);

  const publish = async () => {
    setBusy(true);
    try {
      await persist();
      const r = await api<{ team: AgentTeam }>(`/api/agent-teams/${teamId}/publish`, { method: 'POST' });
      setTeam(r.team);
      toast.success(`Published version ${r.team.published?.version}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const unpublish = async () => {
    setBusy(true);
    try {
      const r = await api<{ team: AgentTeam }>(`/api/agent-teams/${teamId}/unpublish`, { method: 'POST' });
      setTeam(r.team);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      dirty.current = false;
      await api(`/api/agent-teams/${teamId}`, { method: 'DELETE' });
      router.push('/agents?view=teams');
    } catch (e) {
      toast.error((e as Error).message);
      setBusy(false);
    }
  };

  const saveMember = (member: TeamMember) =>
    update((c) => {
      const exists = c.members.some((m) => m.id === member.id);
      return { ...c, members: exists ? c.members.map((m) => (m.id === member.id ? member : m)) : [...c.members, member] };
    });
  /** Removing a member hands its reports to its manager and drops it from reviews and consults. */
  const removeMember = (id: string) =>
    update((c) => {
      const gone = c.members.find((m) => m.id === id);
      return {
        ...c,
        members: c.members
          .filter((m) => m.id !== id)
          .map((m) => ({ ...m, ...(m.reportsTo === id && { reportsTo: gone?.reportsTo }), ...(m.reviews?.includes(id) && { reviews: m.reviews.filter((r) => r !== id) }), ...(m.consults?.includes(id) && { consults: m.consults.filter((r) => r !== id) }) })),
      };
    });

  if (loadError) {
    return (
      <>
        <PageHeader title="Team" />
        <PageBody>
          <p className="text-[13px] text-t2">{loadError}</p>
          <Link href="/agents?view=teams" className="mt-2 inline-block text-[13px] font-semibold text-ac hover:underline">
            Back to teams
          </Link>
        </PageBody>
      </>
    );
  }
  if (!draft || !team) {
    return (
      <>
        <PageHeader title="Team" />
        <PageBody>
          <div className="h-[200px] animate-pulse-soft rounded-2xl border border-hair bg-sf" />
        </PageBody>
      </>
    );
  }

  const published = team.published;
  const card = (member: TeamMember, inSection = false) => (
    <MemberCard
      key={member.id}
      config={draft}
      member={member}
      agent={memberAgent(member, agents ?? [])}
      lead={!member.reportsTo}
      inSection={inSection}
      onEdit={() => setEditing({ member })}
      onAddReport={member.kind === 'agent' ? () => setEditing({ reportsTo: member.id }) : undefined}
    />
  );
  // The chart in sections, breadth first: the lead on top, then one grid of equal cards per manager's direct reports.
  const sections: OrgNode[] = [];
  for (let queue = tree ? [tree] : []; queue.length; ) {
    const node = queue.shift()!;
    if (node.reports.length) sections.push(node);
    queue.push(...node.reports);
  }
  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link href="/agents?view=teams" aria-label="Back to teams" className="grid size-7 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1">
              <ArrowLeft className="size-4" />
            </Link>
            {draft.name || 'Untitled team'}
          </span>
        }
        meta={
          <>
            {published ? <Badge tone="success">Published v{published.version}</Badge> : <Badge tone="muted">Draft</Badge>}
            <span aria-live="polite">{save === 'saved' ? 'Saved' : save === 'error' ? 'Not saved' : 'Saving…'}</span>
          </>
        }
      />
      <PageBody className="mx-auto w-full max-w-[960px] px-4 sm:px-6">
        <div role="tablist" aria-label="Team" className="mb-3 flex gap-1 border-b border-hair">
          {([['chart', 'Chart'], ['notebook', 'Notebook']] as const).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => showTab(id)}
              className={cn('-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-semibold transition-colors', tab === id ? 'border-ac text-t1' : 'border-transparent text-t3 hover:text-t1')}
            >
              {label}
              {id === 'notebook' && noteTotal !== undefined && noteTotal > 0 && <span className="rounded-full bg-acdim px-1.5 text-[11px] tabular-nums text-ac">{noteTotal}</span>}
            </button>
          ))}
        </div>
        {tab === 'notebook' && <NotebookTab teamId={teamId} faces={draft.members.map((m) => ({ title: m.title, agent: memberAgent(m, agents ?? []) }))} />}
        <div className={cn('flex flex-col gap-4', tab === 'notebook' && 'hidden')}>
          <Field id="team-name" label="Name">
            <Input id="team-name" value={draft.name} onChange={(e) => update((c) => ({ ...c, name: e.target.value }))} placeholder="Plugin team" />
          </Field>
          <Field id="team-goal" label="Goal" hint="What the team is for: every request inside it carries this.">
            <Textarea id="team-goal" rows={2} value={draft.goal ?? ''} onChange={(e) => update((c) => ({ ...c, goal: e.target.value }))} placeholder="Build approved plugins on a branch, tested and reviewed" />
          </Field>

          <section aria-label="Org chart">
            <div className="mb-1.5 flex items-center justify-between">
              <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-t3">Members</h2>
              <Button size="sm" onClick={() => setEditing({})}>
                <Plus className="size-3.5" strokeWidth={2} /> Add member
              </Button>
            </div>
            {draft.members.length === 0 && <p className="rounded-2xl border border-dashed border-hair px-4 py-8 text-center text-[13px] text-t3">No members yet. Add the lead first, then the members who report to it.</p>}
            <div ref={chartRef} className="relative">
            {tree && (
              <div className="flex flex-col items-center">
                <div className="w-full sm:max-w-[360px]">{card(tree.member)}</div>
                {sections.map((node) => (
                  <div key={node.member.id} className="flex w-full flex-col items-center">
                    <div className="h-5 w-px bg-hair" aria-hidden />
                    <section aria-label={`Reports to ${node.member.title}`} className="w-full">
                      <h3 className="mb-2 text-center text-[12px] text-t3">
                        Reports to {node.member.title} · {node.reports.length}
                      </h3>
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{node.reports.map((n) => card(n.member, true))}</div>
                    </section>
                  </div>
                ))}
              </div>
            )}
            {loose.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 text-[12px] text-t3">Not in the chart yet</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">{loose.map((m) => card(m))}</div>
              </div>
            )}
            {/* The "may consult" lines: dashed, in the consulting member's colour, over the cards. */}
            <ConsultLines
              containerRef={chartRef}
              members={draft.members}
              titles={Object.fromEntries(draft.members.map((m) => [m.id, m.title]))}
              colors={Object.fromEntries(draft.members.flatMap((m) => { const c = memberAgent(m, agents ?? []); const color = c && faceOf(c).color; return color ? [[m.id, color]] : []; }))}
            />
            </div>
          </section>

          <LastRun teamId={teamId} faces={draft.members.map((m) => ({ title: m.title, agent: memberAgent(m, agents ?? []) }))} />
          {flows.length > 0 && (
            <section aria-label="Flows that run this team" className="rounded-[12px] border border-hair bg-sf px-3.5 py-3">
              <h2 className="mb-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-t3">{fromTemplate ? 'Created from the template' : 'Flows that run this team'}</h2>
              <ul className="flex flex-col gap-1.5">
                {flows.map((f) => (
                  <li key={f.id}>
                    <Link href={`/workflows/${f.id}`} className={cn('flex items-center gap-2 rounded-[10px] border px-2.5 py-2 text-[13px] hover:border-ac', f.id === fromTemplate ? 'border-ac bg-acdim' : 'border-hair bg-wl')}>
                      <Workflow className="size-3.5 shrink-0 text-t3" />
                      <span className="min-w-0 flex-1 truncate font-semibold text-t1">{f.name}</span>
                      <span className="shrink-0 text-[11px] text-t3">{f.active ? 'Active' : 'Draft'}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {issues.length > 0 && (
            <div role="status" className="rounded-[12px] border border-warnbd bg-warndim px-3.5 py-3 text-[12px] text-warn">
              <div className="mb-1 flex items-center gap-1.5 font-semibold">
                <TriangleAlert className="size-3.5" /> Fix these before publishing
              </div>
              <ul className="list-disc space-y-0.5 pl-5">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={busy} disabled={issues.length > 0} onClick={() => void publish()}>
              {published ? 'Publish changes' : 'Publish'}
            </Button>
            {published && (
              <Button disabled={busy} onClick={() => void unpublish()}>
                Unpublish
              </Button>
            )}
            <Button className="ml-auto" onClick={() => setSaveTemplate(true)}>
              <LayoutTemplate className="size-3.5" /> Save as template
            </Button>
            <Button onClick={() => setExporting(true)}>
              <Package className="size-3.5" /> Export as Claude Code plugin
            </Button>
            <Button variant="ghost" className="text-rd" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" /> Delete team
            </Button>
          </div>
          {confirmDelete && (
            <div role="alertdialog" aria-label="Delete this team" className="rounded-[12px] border border-rdbd bg-rddim px-3.5 py-3 text-[12px] text-t1">
              <p>Delete “{draft.name || 'Untitled team'}”? Flows that run it will stop working. The agents in it stay.</p>
              <div className="mt-2.5 flex gap-2">
                <Button size="sm" variant="danger" loading={busy} onClick={() => void remove()}>
                  Delete team
                </Button>
                <Button size="sm" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </div>
      </PageBody>
      {saveTemplate && <SaveTeamTemplateDialog teamId={teamId} teamName={draft.name || 'Untitled team'} goal={draft.goal} onClose={() => setSaveTemplate(false)} />}
      {exporting && <ExportPluginDialog base={`/api/agent-teams/${teamId}`} title={draft.name || 'Untitled team'} onClose={() => setExporting(false)} />}
      {editing && (
        <MemberDialog
          key={editing.member?.id ?? 'new'}
          config={draft}
          member={editing.member}
          reportsTo={editing.reportsTo}
          agents={agents ?? []}
          onSave={(m) => {
            saveMember(m);
            setEditing(undefined);
          }}
          onRemove={
            editing.member
              ? () => {
                  removeMember(editing.member!.id);
                  setEditing(undefined);
                }
              : undefined
          }
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

const tokens = formatTokens;

function MemberCard({ config, member, agent, lead, inSection, onEdit, onAddReport }: { config: AgentTeamConfig; member: TeamMember; agent?: AgentSummary; lead: boolean; inSection?: boolean; onEdit: () => void; onAddReport?: () => void }) {
  const manager = managerOf(config, member);
  const reviews = (member.reviews ?? []).map((id) => config.members.find((m) => m.id === id)?.title).filter(Boolean);
  const reviewedBy = config.members.filter((m) => m.reviews?.includes(member.id)).map((m) => m.title);
  const consults = (member.consults ?? []).map((id) => config.members.find((m) => m.id === id)?.title).filter(Boolean);
  // A footer only when it has something to say: a card in a row without one keeps its height (the grid) and its role.
  const chips = Boolean((manager && !inSection) || reviews.length || reviewedBy.length || consults.length || member.budgetTokens !== undefined || member.questionsTo === 'person');
  const runsOn = member.kind === 'a2a' ? (agent ? `${agent.name} on kagent` : 'Remote agent over A2A') : agent ? 'Landflow agent' : 'Pick an agent';
  return (
    // A card: who (face, title, where it runs), what it does, and its relations in a footer, so cards in a row line up.
    <article data-member-id={member.id} className={cn('flex h-full flex-col overflow-hidden rounded-2xl border bg-sf transition-colors hover:border-bd', lead ? 'border-acbd' : 'border-hair')}>
      <button type="button" onClick={onEdit} className="flex flex-1 flex-col gap-2 p-3 text-left focus-visible:outline-2 focus-visible:outline-ac">
        <span className={cn('-m-3 mb-0 flex items-center gap-3 p-3', lead && 'bg-acdim')}>
          {/* A remote member that calls a Landflow agent on kagent wears that agent's face. */}
          {member.kind === 'agent' || agent ? <AgentAvatar agent={agent ?? { name: member.title }} size={48} /> : <A2aTile size={48} />}
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-[15px] font-semibold text-t1">{member.title || 'Untitled'}</span>
              {lead && <Badge tone="accent">Lead</Badge>}
            </span>
            <span className="flex items-center gap-1 text-[12px] text-t3">
              {member.kind === 'a2a' && <RadioTower className="size-3 shrink-0" />}
              <span className="truncate">{runsOn}</span>
            </span>
          </span>
        </span>
        <span className="line-clamp-3 text-[12.5px] leading-snug text-t2">{member.role || (agent?.role ? `${agent.name}, ${agent.role}` : 'No role yet: tap to say what it does.')}</span>
      </button>
      {(chips || onAddReport || !manager) && (
        <div className="mt-auto flex min-h-[44px] flex-wrap items-center gap-1.5 border-t border-hair px-3 py-2">
          {manager && !inSection && <Chip>Reports to {manager.title}</Chip>}
          {reviews.length > 0 && <Chip tone="accent">Reviews {reviews.join(', ')}</Chip>}
          {reviewedBy.length > 0 && <Chip>Reviewed by {reviewedBy.join(', ')}</Chip>}
          {/* A dashed chip: a standing line between peers, not a reporting line. */}
          {consults.length > 0 && (
            <Chip tone="accent" className="border-dashed">
              May consult {consults.join(', ')}
            </Chip>
          )}
          {member.budgetTokens !== undefined && <Chip>{tokens(member.budgetTokens)} tokens a run</Chip>}
          {member.questionsTo === 'person' && <Chip>Questions go to a person</Chip>}
          {!manager && !chips && <span className="text-[12px] text-t3">Runs the team</span>}
          {onAddReport && (
            <button type="button" onClick={onAddReport} className="ml-auto rounded text-[12px] font-semibold text-ac hover:underline focus-visible:outline-2 focus-visible:outline-ac">
              + Add a report
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function MemberDialog({
  config,
  member,
  reportsTo,
  agents,
  onSave,
  onRemove,
  onClose,
}: {
  config: AgentTeamConfig;
  member?: TeamMember;
  /** A new member's manager. */
  reportsTo?: string;
  agents: AgentSummary[];
  onSave: (member: TeamMember) => void;
  onRemove?: () => void;
  onClose: () => void;
}) {
  const nodeTypes = useNodeTypes();
  const info = nodeTypes?.[A2A_AGENT];
  const properties = (info?.descriptor.properties ?? []).filter((p) => SERVER_PROPERTIES.has(p.name));
  const root = config.members.find((m) => !m.reportsTo);
  const [value, setValue] = useState<TeamMember>(() => {
    if (member) return member;
    // The first member leads; the rest report to the lead unless asked otherwise.
    return { id: newId('m'), kind: 'agent', agentId: '', title: '', ...((reportsTo ?? root?.id) && { reportsTo: reportsTo ?? root?.id }) } as TeamMember;
  });
  const [confirm, setConfirm] = useState(false);
  const set = (patch: Partial<TeamMember>) => setValue((v) => ({ ...v, ...patch }) as TeamMember);
  const others = config.members.filter((m) => m.id !== value.id);
  const descendants = member ? below(config, member.id) : new Set<string>();
  const managers = others.filter((m) => m.kind === 'agent' && !descendants.has(m.id));
  const hasRoot = others.some((m) => !m.reportsTo);

  const switchKind = (kind: 'agent' | 'a2a') => {
    if (kind === value.kind) return;
    const { id, title, role, reportsTo: up, reviews, budgetTokens, questionsTo } = value;
    const base = { id, title, role, reportsTo: up, reviews, budgetTokens, questionsTo };
    if (kind === 'agent') setValue({ ...base, kind, agentId: '' } as TeamMember);
    else setValue({ ...base, kind, parameters: info ? Object.fromEntries(Object.entries(defaultParameters(info.descriptor)).filter(([k]) => SERVER_PROPERTIES.has(k))) : {} } as TeamMember);
  };
  const pickAgent = (agentId: string) => {
    const agent = agents.find((a) => a.id === agentId);
    setValue((v) => ({ ...v, agentId, ...(!v.title.trim() && agent && { title: agent.role || agent.name }) }) as TeamMember);
  };
  const requirements = value.kind === 'a2a' ? (info?.descriptor.credentials ?? []).filter((c) => isPropertyVisible(c, withPropertyDefaults(info?.descriptor.properties ?? [], value.parameters))) : [];

  const finish = () => {
    const role = value.role?.trim();
    const { reviews, consults, ...rest } = value;
    onSave({ ...rest, title: value.title.trim(), ...(role ? { role } : { role: undefined }), ...(reviews?.length && { reviews }), ...(value.kind === 'agent' && consults?.length && { consults }) } as TeamMember);
  };

  return (
    <Dialog
      title={member ? member.title || 'Member' : 'Add a member'}
      subtitle="A Landflow agent, or a remote agent over A2A"
      onClose={onClose}
      width={600}
      footer={
        <>
          {onRemove && (
            <Button variant="ghost" size="sm" className="mr-auto text-rd" onClick={() => (confirm ? onRemove() : setConfirm(true))}>
              {confirm ? 'Remove from the team?' : 'Remove'}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!value.title.trim()} onClick={finish}>
            {member ? 'Save member' : 'Add member'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div role="group" aria-label="Kind" className="inline-flex rounded-full border border-hair bg-wl p-0.5">
          {([['agent', 'Landflow agent'], ['a2a', 'Remote agent']] as const).map(([kind, text]) => (
            <button
              key={kind}
              type="button"
              aria-pressed={value.kind === kind}
              onClick={() => switchKind(kind)}
              className={cn('rounded-full px-3 py-1 text-[12px] font-semibold focus-visible:outline-2 focus-visible:outline-ac', value.kind === kind ? 'bg-acdim text-ac' : 'text-t2 hover:text-t1')}
            >
              {text}
            </button>
          ))}
        </div>
        {value.kind === 'agent' ? (
          <Field id="member-agent" label="Agent" required>
            <Select id="member-agent" value={value.agentId} onChange={(e) => pickAgent(e.target.value)}>
              <option value="">Choose an agent</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.role ? `, ${a.role}` : ''}
                </option>
              ))}
            </Select>
          </Field>
        ) : (
          <>
            {!info && <p className="text-[12px] text-warn">The A2A Agent node type isn’t loaded yet, so the remote agent’s settings can’t be shown.</p>}
            {requirements.length > 0 && <NodeCredentials nodeType={A2A_AGENT} requirements={requirements} value={value.credentials} onChange={(credentials) => set({ credentials })} />}
            {info && <ParamForm nodeType={A2A_AGENT} properties={properties} values={value.parameters} onChange={(parameters) => set({ parameters })} credentials={value.credentials} />}
          </>
        )}
        <Field id="member-title" label="Title" required hint="How its manager calls it: Developer, Reviewer.">
          <Input id="member-title" value={value.title} onChange={(e) => set({ title: e.target.value })} />
        </Field>
        <Field id="member-role" label="Role" hint="What it does, in a sentence. Its manager reads this to know when to ask it.">
          <Textarea id="member-role" rows={2} value={value.role ?? ''} onChange={(e) => set({ role: e.target.value })} />
        </Field>
        <Field id="member-reports" label="Reports to" hint={value.kind === 'a2a' ? undefined : 'Only Landflow agents can manage, so only they are listed.'}>
          <Select id="member-reports" value={value.reportsTo ?? ''} onChange={(e) => set({ reportsTo: e.target.value || undefined })}>
            <option value="" disabled={hasRoot}>
              Nobody: the lead
            </option>
            {managers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.title || 'Untitled'}
              </option>
            ))}
          </Select>
        </Field>
        {others.length > 0 && (
          <fieldset>
            <legend className="mb-[5px] text-[12px] font-semibold text-t2">Reviews</legend>
            <div className="space-y-1">
              {others.map((m) => {
                const on = value.reviews?.includes(m.id) ?? false;
                return (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-[10px] border border-hair bg-wl px-3 py-2 text-[13px] text-t1">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => set({ reviews: on ? (value.reviews ?? []).filter((r) => r !== m.id) : [...(value.reviews ?? []), m.id] })}
                      className="size-4 accent-[var(--ac)]"
                    />
                    {m.title || 'Untitled'}
                    {on && <Check className="ml-auto size-3.5 text-ac" />}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-[12px] leading-snug text-t3">Their manager can’t report done until this member signs off their work.</p>
          </fieldset>
        )}
        {others.length > 0 && value.kind === 'agent' && (
          <fieldset>
            <legend className="mb-[5px] text-[12px] font-semibold text-t2">May consult</legend>
            <div className="space-y-1">
              {others.map((m) => {
                const on = value.consults?.includes(m.id) ?? false;
                return (
                  <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded-[10px] border border-dashed border-hair bg-wl px-3 py-2 text-[13px] text-t1">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => set({ consults: on ? (value.consults ?? []).filter((r) => r !== m.id) : [...(value.consults ?? []), m.id] })}
                      className="size-4 accent-[var(--ac)]"
                    />
                    {m.title || 'Untitled'}
                    {on && <Check className="ml-auto size-3.5 text-ac" />}
                  </label>
                );
              })}
            </div>
            <p className="mt-1 text-[12px] leading-snug text-t3">It can ask them a question directly (the answer comes back to it, not to its manager) or hand its task over to them, without going through its manager.</p>
          </fieldset>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="member-budget" label="Budget" hint="Tokens it may spend in one run. Empty: no limit.">
            <Input
              id="member-budget"
              type="number"
              min={1}
              inputMode="numeric"
              value={value.budgetTokens ?? ''}
              onChange={(e) => set({ budgetTokens: e.target.value ? Math.max(0, Math.floor(Number(e.target.value))) : undefined })}
            />
          </Field>
          <Field id="member-questions" label="Questions go to">
            <Select id="member-questions" value={value.questionsTo ?? 'manager'} onChange={(e) => set({ questionsTo: e.target.value as 'manager' | 'person' })}>
              <option value="manager">Its manager first</option>
              <option value="person">A person</option>
            </Select>
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

interface LastTeamRun {
  executionId: string;
  workflowName: string;
  status: string;
  startedAt: string;
  nodeName: string;
  durationMs?: number;
  /** Going on now: read from the team node's live progress. */
  live?: boolean;
  /** The member at work (a live run). */
  member?: string;
  members: Array<{ title: string; tokens: number; budgetTokens?: number; estimated?: boolean; overBudget?: boolean; costUsd?: number; notAsked?: boolean; working?: boolean }>;
  moments?: TeamMoment[];
}

const LIVE_POLL_MS = 4_000;

/**
 * The team's latest run in a flow: when, and what each member used against its budget, with a way into its Run Trace.
 * While a run goes on it reads again every few seconds, so the bars fill as the members work; a member its manager never
 * asked says so beside an empty bar.
 */
function LastRun({ teamId, faces }: { teamId: string; faces: Array<{ title: string; agent?: AgentSummary }> }) {
  const [run, setRun] = useState<LastTeamRun | null>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let gone = false;
    api<{ run?: LastTeamRun }>(`/api/agent-teams/${teamId}/last-run`)
      .then((r) => !gone && setRun(r.run ?? null))
      .catch(() => !gone && setRun((prev) => prev ?? null));
    return () => {
      gone = true;
    };
  }, [teamId, tick]);
  const live = Boolean(run?.live);
  useEffect(() => {
    if (!live) return;
    const timer = setTimeout(() => setTick((n) => n + 1), LIVE_POLL_MS);
    return () => clearTimeout(timer);
  }, [live, tick]);
  if (!run || !run.members.length) return null;
  const when = new Date(run.startedAt);
  return (
    <section aria-label={run.live ? 'Running now' : 'Last run'} className={cn('rounded-2xl border bg-sf p-3.5', run.live ? 'border-gn/40' : 'border-hair')} data-testid="team-last-run" data-live={run.live || undefined}>
      <div className="mb-2.5 flex items-baseline justify-between gap-2">
        {run.live ? (
          <h2 className="flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-[0.06em] text-gn">
            <span className="size-1.5 animate-pulse rounded-full bg-gn" aria-hidden />
            Running now
          </h2>
        ) : (
          <h2 className="text-[12px] font-semibold uppercase tracking-[0.06em] text-t3">Last run</h2>
        )}
        <Link href={`/runs/${run.executionId}?tab=team`} className="truncate text-[12px] font-semibold text-t1 hover:underline">
          {run.workflowName} · {when.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} →
        </Link>
      </div>
      <ul className="flex flex-col gap-2">
        {run.members.map((m) => {
          const face = faces.find((f) => f.title === m.title);
          return (
            <li key={m.title} className={cn('flex min-w-0 items-center gap-2.5', m.notAsked && 'opacity-60')} data-testid="team-last-run-member" data-not-asked={m.notAsked || undefined}>
              <span className={cn('relative shrink-0 rounded-lg', m.working && 'ring-2 ring-gn ring-offset-1 ring-offset-sf')}>
                {face?.agent ? <AgentAvatar agent={faceOf(face.agent)} size={24} /> : <span className="grid size-6 place-items-center rounded-lg bg-acdim text-[11px] font-semibold text-t2">{m.title.charAt(0)}</span>}
              </span>
              <span className="w-28 shrink-0 truncate text-[13px] text-t1">
                {m.title}
                {m.working && <span className="ml-1 text-[11px] text-gn">· working</span>}
              </span>
              {m.notAsked ? (
                // An empty bar with its budget: the budget is set, the member just wasn't needed.
                <span className="flex min-w-0 flex-1 items-center gap-2" title={`${m.title} wasn't asked in this run`}>
                  <span className="h-1 min-w-0 flex-1 rounded-full bg-acdim" />
                  <span className="shrink-0 font-mono text-[10px] tabular-nums text-t3">not asked{m.budgetTokens ? ` · of ${tokens(m.budgetTokens)}` : ''}</span>
                </span>
              ) : m.budgetTokens ? (
                <BudgetBar usage={{ member: m.title, tokens: m.tokens, budget: m.budgetTokens, ...(m.estimated && { estimated: true }) }} color={face?.agent ? faceOf(face.agent).color : undefined} className="min-w-0 flex-1" />
              ) : (
                <span className="font-mono text-[11px] tabular-nums text-t3">
                  {m.estimated ? '~' : ''}
                  {tokens(m.tokens)} tokens · no budget
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {run.moments && run.moments.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1 border-t border-hair pt-2.5">
          {run.moments.map((m, i) => (
            <span key={`${m.at}:${i}`} className={cn('rounded-full px-2 py-px text-[11px] font-medium', m.tone === 'ok' ? 'bg-gn/12 text-gn' : m.tone === 'bad' ? 'bg-rd/10 text-rd' : m.tone === 'warn' ? 'bg-warndim text-warn' : 'bg-acdim text-t2')}>
              {m.text}
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
