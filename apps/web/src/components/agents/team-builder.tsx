'use client';
/**
 * A team's page (docs/agent-teams.md): its name and goal, the org chart as an indented tree of member cards (one column, so it
 * reads on a phone), what stops it from being published, and Publish. Every change to the draft autosaves after a pause.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Check, Plus, RadioTower, TriangleAlert, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { defaultParameters, isPropertyVisible, withPropertyDefaults } from '@landflow/protocol';
import { api, ApiError } from '@/lib/client/api';
import type { AgentSummary } from '@/lib/shared/agents';
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
import { useAgentList, useNodeTypes } from './use-agent-data';
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

  const latest = useRef<AgentTeamConfig>(undefined);
  const dirty = useRef(false);
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
  /** Removing a member hands its reports to its manager and drops it from reviews. */
  const removeMember = (id: string) =>
    update((c) => {
      const gone = c.members.find((m) => m.id === id);
      return {
        ...c,
        members: c.members
          .filter((m) => m.id !== id)
          .map((m) => ({ ...m, ...(m.reportsTo === id && { reportsTo: gone?.reportsTo }), ...(m.reviews?.includes(id) && { reviews: m.reviews.filter((r) => r !== id) }) })),
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
  const card = (member: TeamMember) => (
    <MemberCard
      key={member.id}
      config={draft}
      member={member}
      agent={memberAgent(member, agents ?? [])}
      lead={!member.reportsTo}
      onEdit={() => setEditing({ member })}
      onAddReport={member.kind === 'agent' ? () => setEditing({ reportsTo: member.id }) : undefined}
    />
  );
  const branch = (node: OrgNode, depth: number): React.ReactNode => (
    <div key={node.member.id} className={cn(depth > 0 && 'ml-3 border-l border-hair pl-3 sm:ml-5 sm:pl-5')}>
      <div className="py-1.5">{card(node.member)}</div>
      {node.reports.map((n) => branch(n, depth + 1))}
    </div>
  );

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
      <PageBody className="mx-auto w-full max-w-[760px] px-4 sm:px-6">
        <div className="flex flex-col gap-4">
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
            {tree && branch(tree, 0)}
            {loose.length > 0 && (
              <div className="mt-2">
                <div className="mb-1 text-[12px] text-t3">Not in the chart yet</div>
                <div className="flex flex-col gap-2">{loose.map(card)}</div>
              </div>
            )}
          </section>

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
            <Button variant="ghost" className="ml-auto text-rd" onClick={() => setConfirmDelete(true)}>
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

const tokens = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

function MemberCard({ config, member, agent, lead, onEdit, onAddReport }: { config: AgentTeamConfig; member: TeamMember; agent?: AgentSummary; lead: boolean; onEdit: () => void; onAddReport?: () => void }) {
  const manager = managerOf(config, member);
  const reviews = (member.reviews ?? []).map((id) => config.members.find((m) => m.id === id)?.title).filter(Boolean);
  return (
    <article className="rounded-2xl border border-hair bg-sf p-3 transition-colors hover:border-bd">
      <div className="flex items-start gap-3">
        {/* A remote member that calls a Landflow agent on kagent wears that agent's face. */}
        {member.kind === 'agent' || agent ? <AgentAvatar agent={agent ?? { name: member.title }} size={44} /> : <A2aTile size={44} />}
        <button type="button" onClick={onEdit} className="min-w-0 flex-1 rounded text-left focus-visible:outline-2 focus-visible:outline-ac">
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-[14px] font-semibold text-t1">{member.title || 'Untitled'}</span>
            {lead && <Badge tone="accent">Lead</Badge>}
          </span>
          <span className="block text-[12px] text-t2">{member.role || (member.kind === 'agent' ? (agent ? `${agent.name}${agent.role ? `, ${agent.role}` : ''}` : 'Pick an agent') : 'Remote agent')}</span>
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {manager && <Chip>Reports to {manager.title}</Chip>}
        {reviews.length > 0 && <Chip tone="accent">Reviews {reviews.join(', ')}</Chip>}
        {member.kind === 'a2a' && (
          <Chip>
            <RadioTower className="size-3" /> {agent ? `${agent.name} on kagent` : 'Remote'}
          </Chip>
        )}
        {member.budgetTokens !== undefined && <Chip>{tokens(member.budgetTokens)} tokens a run</Chip>}
        {member.questionsTo === 'person' && <Chip>Questions go to a person</Chip>}
        {onAddReport && (
          <button type="button" onClick={onAddReport} className="ml-auto rounded text-[12px] font-semibold text-ac hover:underline focus-visible:outline-2 focus-visible:outline-ac">
            + Add a report
          </button>
        )}
      </div>
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
    const { reviews, ...rest } = value;
    onSave({ ...rest, title: value.title.trim(), ...(role ? { role } : { role: undefined }), ...(reviews?.length && { reviews }) } as TeamMember);
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
