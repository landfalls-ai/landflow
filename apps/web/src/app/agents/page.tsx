'use client';
import { DevOnly } from '@/lib/client/developer-details';
/** Agents (Preview): a roster of personas, grouped by team, that use your tools, workflows and other agents. */
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bot, Copy, Download, ExternalLink, MoreHorizontal, Network, Plus, Sparkles, Upload, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { plural, timeAgo } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { Agent, AgentSummary, AgentTemplate } from '@/lib/shared/agents';
import { AgentAvatar } from '@/components/agents/avatar';
import { TeamsView, NewTeamButton } from '@/components/agents/teams-view';
import type { TeamSummary } from '@/lib/shared/agent-teams';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { SaveTemplateDialog } from '@/components/agents/save-template-dialog';
import { configOf, downloadJson, parseAgentFile, slug } from '@/components/agents/util';
import { useAgentData } from '@/components/agents/use-agent-data';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { PhoneFilters } from '@/components/ui/phone-filters';
import { Badge, Chip } from '@/components/ui/badge';
import { SearchInput } from '@/components/ui/inputs';
import { Button } from '@/components/ui/button';
import { MenuItem, Popover } from '@/components/ui/popover';

type Filter = 'all' | 'published' | 'drafts' | 'kagent' | 'marketplace';
type Group = 'team' | 'none';
type View = 'agents' | 'teams';

const FILTERS: Array<[Filter, string, (a: AgentSummary) => boolean]> = [
  ['all', 'All', () => true],
  ['published', 'Published', (a) => Boolean(a.publishedVersion)],
  ['drafts', 'Drafts', (a) => !a.publishedVersion],
  ['kagent', 'On kagent', (a) => Boolean(a.kagent)],
  ['marketplace', 'From marketplace', (a) => Boolean(a.marketplace)],
];
const CHANNEL_LABELS: Record<string, string> = { slack: 'Slack', teams: 'Teams', telegram: 'Telegram' };

const matches = (a: AgentSummary, q: string) =>
  [a.name, a.role, a.description, a.team, ...(a.tones ?? [])].some((s) => s?.toLowerCase().includes(q));

export default function AgentsPage() {
  const router = useRouter();
  const agents = useAgentData((s) => s.agents);
  const [loaded, setLoaded] = useState(false);
  const [templates, setTemplates] = useState<AgentTemplate[]>();
  const [dialog, setDialog] = useState<{ template?: string; mode?: 'architect' }>();
  const [saving, setSaving] = useState<AgentSummary>();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [group, setGroup] = useState<Group>('team');
  const [view, setViewState] = useState<View>('agents');
  const [agentTeams, setAgentTeams] = useState<TeamSummary[]>();
  const fileInput = useRef<HTMLInputElement>(null);

  const setView = (next: View) => {
    setViewState(next);
    window.history.replaceState(null, '', next === 'teams' ? '/agents?view=teams' : '/agents');
  };

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') === 'teams') setViewState('teams');
    api<{ teams: TeamSummary[] }>('/api/agent-teams')
      .then((r) => setAgentTeams(r.teams))
      .catch(() => setAgentTeams([]));
    void useAgentData.getState().loadAgents().finally(() => setLoaded(true));
    api<{ templates: AgentTemplate[] }>('/api/agent-templates')
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
  }, []);

  const importFile = async (file?: File) => {
    if (!file) return;
    try {
      const config = parseAgentFile(await file.text());
      const { agent } = await api<{ agent: { id: string; name: string } }>('/api/agents/import', { method: 'POST', json: { config } });
      toast.success(`Imported “${agent.name}”`);
      router.push(`/agents/${agent.id}`);
    } catch (e) {
      toast.error(`Could not import ${file.name}: ${(e as Error).message}`);
    } finally {
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  // The teams each agent is a member of, for the chip on its card.
  const teamsOf = useMemo(() => {
    const out = new Map<string, TeamSummary[]>();
    for (const team of agentTeams ?? []) for (const id of team.agentIds ?? []) out.set(id, [...(out.get(id) ?? []), team]);
    return out;
  }, [agentTeams]);

  const list = loaded ? agents : undefined;
  const teams = useMemo(() => [...new Set((agents ?? []).map((a) => a.team).filter((t): t is string => Boolean(t)))].sort((a, b) => a.localeCompare(b)), [agents]);

  const visible = useMemo(() => {
    if (!list) return undefined;
    const q = query.trim().toLowerCase();
    const test = FILTERS.find((f) => f[0] === filter)![2];
    return [...list].filter((a) => test(a) && (!q || matches(a, q))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [list, query, filter]);

  const sections = useMemo(() => {
    if (!visible) return [];
    if (group === 'none' || teams.length === 0) return [{ team: undefined as string | undefined, agents: visible }];
    const out = teams.map((team) => ({ team: team as string | undefined, agents: visible.filter((a) => a.team === team) })).filter((s) => s.agents.length);
    const rest = visible.filter((a) => !a.team);
    if (rest.length) out.push({ team: undefined, agents: rest });
    return out;
  }, [visible, group, teams]);
  const headed = group === 'team' && teams.length > 0;

  const exportAgent = async (agent: AgentSummary) => {
    try {
      const { agent: full } = await api<{ agent: Agent }>(`/api/agents/${agent.id}`);
      downloadJson(`${slug(full.name)}.agent.json`, configOf(full));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const openNew = (template?: string) => setDialog({ template });
  const openArchitect = () => setDialog({ mode: 'architect' });
  const strip = templates && templates.length > 0 && (
    <section aria-label="Start from a persona" className="mb-6">
      <div className="mb-2 flex items-center justify-between max-md:flex-wrap max-md:gap-y-1">
        <h2 className="whitespace-nowrap text-[12px] font-semibold uppercase tracking-[0.06em] text-t3">Start from a persona</h2>
        <div className="flex items-center gap-4 whitespace-nowrap max-md:w-full max-md:justify-start">
          <button type="button" onClick={openArchitect} className="flex items-center gap-1 rounded text-[12px] font-semibold text-ac hover:underline focus-visible:outline-2 focus-visible:outline-ac">
            <Sparkles className="size-3" /> Ask the Agent architect
          </button>
          <button type="button" onClick={() => openNew()} className="rounded text-[12px] font-semibold text-ac hover:underline focus-visible:outline-2 focus-visible:outline-ac">
            All templates
          </button>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-2">
        {templates.filter((t) => t.id !== 'blank').slice(0, 6).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => openNew(t.id)}
            className="flex items-center gap-2.5 rounded-xl border border-hair bg-sf px-3 py-2.5 text-left transition-colors hover:border-bd focus-visible:outline-2 focus-visible:outline-ac"
          >
            <AgentAvatar agent={{ name: t.name, icon: t.config.icon || 'bot', color: t.config.color || '#a855f7', avatar: t.config.avatar }} size={34} />
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-semibold text-t1">{t.name}</span>
              <span className="block truncate text-[12px] text-t3">{t.description}</span>
            </span>
          </button>
        ))}
      </div>
    </section>
  );

  const actions = (
    <>
      <SearchInput value={query} onChange={setQuery} placeholder="Search agents" className="w-[200px]" />
      <Button size="sm" onClick={() => fileInput.current?.click()}>
        <Upload className="size-3.5" /> <span className="hidden sm:inline">Import JSON</span>
      </Button>
      <Button variant="primary" size="sm" onClick={() => openNew()}>
        <Plus className="size-3.5" strokeWidth={2} /> New agent
      </Button>
    </>
  );

  const seg = <T extends string>(label: string, value: T, set: (v: T) => void, options: Array<[T, string, number?]>) => (
    <div role="group" aria-label={label} className="inline-flex max-w-full overflow-x-auto rounded-full border border-hair bg-wl p-0.5 [scrollbar-width:none] max-md:flex-wrap max-md:overflow-visible max-md:rounded-2xl">
      {options.map(([key, text, n]) => (
        <button
          key={key}
          type="button"
          aria-pressed={value === key}
          onClick={() => set(key)}
          className={cn(
            'shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[12px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-ac',
            value === key ? 'bg-acdim text-ac' : 'text-t2 hover:text-t1',
          )}
        >
          {text}
          {n !== undefined && <span className="ml-1.5 tabular-nums text-t3">{n}</span>}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <PageHeader
        title="Agents"
        meta={
          <>
            <span className="hidden rounded-full border border-acbd bg-acdim px-1.5 text-[10px] font-semibold leading-4 text-ac sm:inline">Preview</span>
            {list && list.length > 0 && <span className="hidden sm:inline">{plural(list.length, 'agent')}</span>}
          </>
        }
        actions={view === 'agents' ? actions : <NewTeamButton />}
      />
      <input ref={fileInput} type="file" accept=".json,application/json" className="hidden" onChange={(e) => void importFile(e.target.files?.[0])} />
      <PageBody>
        <div className="mb-5">{seg<View>('View', view, setView, [['agents', 'Agents', list?.length], ['teams', 'Teams', agentTeams?.length]])}</div>
        {view === 'teams' && <TeamsView teams={agentTeams} agents={list ?? []} />}
        {view === 'agents' && !visible && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-[190px] rounded-2xl border border-hair bg-sf animate-pulse-soft" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        )}
        {view === 'agents' && list && list.length === 0 && (
          <>
            {strip}
            <Card className="py-6">
              <EmptyState
                icon={<Bot />}
                title="No agents yet"
                hint="Agents automate tasks and answer questions using your connected tools and data."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button onClick={() => openNew()}>
                      <Plus className="size-3.5" strokeWidth={2} /> New agent
                    </Button>
                    <Button variant="ghost" onClick={openArchitect}>
                      <Sparkles className="size-3.5" /> Ask the Agent architect
                    </Button>
                  </div>
                }
              />
            </Card>
          </>
        )}
        {view === 'agents' && list && list.length > 0 && visible && (
          <>
            {strip}
            <div className="mb-5 flex flex-wrap items-center gap-3">
              {/* A phone: which agents and how they're grouped, in a Filters sheet (desktop: in place). */}
              <PhoneFilters
                active={(filter !== 'all' ? 1 : 0) + (group !== 'team' ? 1 : 0)}
                onClear={() => {
                  setFilter('all');
                  setGroup('team');
                }}
              >
                {seg('Show', filter, setFilter, FILTERS.map(([key, text, test]) => [key, text, list.filter(test).length]))}
                <div className="ml-auto flex items-center gap-2 text-[12px] text-t3 max-md:ml-0">
                  Group by
                  {seg<Group>('Group by', group, setGroup, [
                    ['team', 'Team'],
                    ['none', 'None'],
                  ])}
                </div>
              </PhoneFilters>
            </div>
            {visible.length === 0 && <p className="py-10 text-center text-[13px] text-t3">No agents match.</p>}
            <div className="flex flex-col gap-7">
              {sections.map((s) => (
                <section key={s.team ?? '_none'} aria-label={headed ? (s.team ?? 'No team') : 'Agents'}>
                  {headed && (
                    <h2 className="mb-2.5 flex items-center gap-2 text-[13px] font-semibold text-t1">
                      <Users className="size-3.5 text-t3" />
                      {s.team ?? 'No team'}
                      <span className="text-[12px] font-normal text-t3">{s.agents.length}</span>
                    </h2>
                  )}
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                    {s.agents.map((agent, i) => (
                      <AgentCard key={agent.id} agent={agent} teams={teamsOf.get(agent.id)} index={i} onSave={() => setSaving(agent)} onExport={() => void exportAgent(agent)} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </PageBody>
      {dialog && templates && <NewAgentDialog templates={templates} teams={teams} initialTemplateId={dialog.template} initialMode={dialog.mode} onClose={() => setDialog(undefined)} />}
      {saving && (
        <SaveTemplateDialog
          agent={saving}
          onClose={() => setSaving(undefined)}
          onSaved={(t) => setTemplates((list) => (list ? [...list, t] : [t]))}
        />
      )}
    </>
  );
}

function AgentCard({ agent, teams, index, onSave, onExport }: { agent: AgentSummary; teams?: TeamSummary[]; index: number; onSave: () => void; onExport: () => void }) {
  const runs = [
    agent.publishedVersion ? 'Landflow' : undefined,
    agent.kagent ? `kagent ${agent.kagent}` : undefined,
    ...agent.channels.map((c) => CHANNEL_LABELS[c] ?? c),
    agent.schedules > 0 ? `${agent.schedules} ${agent.schedules === 1 ? 'schedule' : 'schedules'}` : undefined,
  ].filter(Boolean) as string[];
  return (
    <article
      className="flex animate-fade-up flex-col gap-3 rounded-2xl border border-hair bg-sf p-4 transition-colors duration-[120ms] hover:border-bd"
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
    >
      <div className="flex items-start gap-3">
        <AgentAvatar agent={agent} size={52} />
        <div className="min-w-0 flex-1">
          <Link href={`/agents/${agent.id}`} className="block truncate rounded text-[14px] font-semibold text-t1 hover:text-ac focus-visible:outline-2 focus-visible:outline-ac">
            {agent.name}
          </Link>
          <div className="truncate text-[12px] text-t2">{agent.role || agent.description || 'No description'}</div>
        </div>
        <Popover
          trigger={({ toggle }) => (
            <Button size="icon-sm" variant="ghost" aria-label={`More actions for ${agent.name}`} aria-haspopup="menu" onClick={toggle}>
              <MoreHorizontal className="size-4" />
            </Button>
          )}
        >
          {(close) => (
            <>
              <Link href={`/agents/${agent.id}`} role="menuitem" className="flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-t1 hover:bg-acdim [&_svg]:size-3.5">
                <ExternalLink /> Open
              </Link>
              <MenuItem
                onClick={() => {
                  close();
                  onSave();
                }}
              >
                <Copy /> Save as template…
              </MenuItem>
              <MenuItem
                onClick={() => {
                  close();
                  onExport();
                }}
              >
                <Download /> Export JSON
              </MenuItem>
            </>
          )}
        </Popover>
      </div>
      {agent.role && agent.description && <p className="line-clamp-2 text-[12px] leading-snug text-t2">{agent.description}</p>}
      {agent.tones && agent.tones.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {agent.tones.map((tone) => (
            <Chip key={tone} className="px-2 text-[11px]">
              {tone}
            </Chip>
          ))}
        </div>
      )}
      <div className="mt-auto flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {agent.publishedVersion ? <Badge tone="success">Published v{agent.publishedVersion}</Badge> : <Badge tone="muted">Draft</Badge>}
          {agent.publishedVersion && agent.draftChanged && <Badge tone="warning">Changes not published</Badge>}
          {runs.length > 0 && <span className="text-[11px] text-t3">{runs.join(' · ')}</span>}
          {teams?.map((team) => (
            <Link key={team.id} href={`/agents/teams/${team.id}`} title={`In the team ${team.name}`} className="rounded-full focus-visible:outline-2 focus-visible:outline-ac">
              <Chip className="px-2 text-[11px] hover:border-bd">
                <Network className="size-3" /> {team.name}
              </Chip>
            </Link>
          ))}
          {agent.marketplace && (
            <Link
              href="/marketplace"
              title={`${agent.marketplace.plugin}@${agent.marketplace.marketplace}`}
              className="rounded text-[11px] text-ac hover:underline focus-visible:outline-2 focus-visible:outline-ac"
            >
              From {agent.marketplace.plugin}
            </Link>
          )}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-hair pt-2 text-[11px] text-t3">
          <DevOnly>
            <span className="min-w-0 truncate">
              <span className="font-mono text-t2">{agent.model || 'No model'}</span> · {agent.tools} {agent.tools === 1 ? 'tool' : 'tools'} · {agent.skills}{' '}
              {agent.skills === 1 ? 'skill' : 'skills'}
            </span>
          </DevOnly>
          <span className="ml-auto shrink-0 tabular-nums">
            {agent.sessions} {agent.sessions === 1 ? 'session' : 'sessions'} · {timeAgo(agent.updatedAt)}
          </span>
        </div>
      </div>
    </article>
  );
}
