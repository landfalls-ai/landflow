'use client';
/** Agents (Preview): a roster of personas, grouped by team, that use your tools, workflows and other agents. */
import { useEffect, useMemo, useState } from 'react';
import { Bot, Plus, Sparkles, Users } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { plural } from '@/lib/client/format';
import { cn } from '@/lib/utils';
import type { Agent, AgentSummary, AgentTemplate } from '@/lib/shared/agents';
import { mergeHarnessSession, newestByAgent, type HarnessSessionView } from '@/lib/shared/harness';
import { useLiveEvents } from '@/lib/client/live';
import { AgentAvatar } from '@/components/agents/avatar';
import { TeamsView, NewTeamButton } from '@/components/agents/teams-view';
import type { TeamSummary } from '@/lib/shared/agent-teams';
import { NewAgentDialog } from '@/components/agents/new-agent-dialog';
import { SaveTemplateDialog } from '@/components/agents/save-template-dialog';
import { configOf, downloadJson, slug } from '@/components/agents/util';
import { useAgentData } from '@/components/agents/use-agent-data';
import { Card, PageBody, PageHeader } from '@/components/shell/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { PhoneFilters } from '@/components/ui/phone-filters';
import { SearchInput } from '@/components/ui/inputs';
import { Button } from '@/components/ui/button';
import { AgentCard } from '@/components/agents/agent-card';
import { showPersonaStrip, visibleFilters } from '@/components/agents/list-rules';

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

const matches = (a: AgentSummary, q: string) =>
  [a.name, a.role, a.description, a.team, ...(a.tones ?? [])].some((s) => s?.toLowerCase().includes(q));

export default function AgentsPage() {
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
  const [harnessSessions, setHarnessSessions] = useState<HarnessSessionView[]>([]);
  const harnessByAgent = useMemo(() => newestByAgent(harnessSessions), [harnessSessions]);
  // The cards' Claude Code status chips: the open sessions once, then each live `harness` event (C04).
  useLiveEvents((event) => {
    if (event.channel === 'harness' && event.session.agentId) setHarnessSessions((list) => mergeHarnessSession(list, event.session));
  });

  const setView = (next: View) => {
    setViewState(next);
    window.history.replaceState(null, '', next === 'teams' ? '/agents?view=teams' : '/agents');
  };

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('view') === 'teams') setViewState('teams');
    api<{ teams: TeamSummary[] }>('/api/agent-teams')
      .then((r) => setAgentTeams(r.teams))
      .catch(() => setAgentTeams([]));
    api<{ sessions: HarnessSessionView[] }>('/api/harness/sessions?open=1&limit=100', { background: true })
      .then((r) => setHarnessSessions(r.sessions))
      .catch(() => {});
    void useAgentData.getState().loadAgents().finally(() => setLoaded(true));
    api<{ templates: AgentTemplate[] }>('/api/agent-templates')
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
  }, []);

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

  const filterKeys = list ? visibleFilters(FILTERS.map(([key, , test]) => [key, list.filter(test).length] as const), filter) : [];
  const openNew = (template?: string) => setDialog({ template });
  const openArchitect = () => setDialog({ mode: 'architect' });
  const strip = templates && templates.length > 0 && showPersonaStrip(list) && (
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
      <PageBody>
        <div className="mb-5">{seg<View>('View', view, setView, [['agents', 'Agents', list?.length], ['teams', 'Teams', agentTeams?.length]])}</div>
        {view === 'teams' && <TeamsView teams={agentTeams} />}
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
            {(filterKeys.length > 0 || teams.length > 0) && (
            <div className="mb-5 flex flex-wrap items-center gap-3">
              {/* A phone: which agents and how they're grouped, in a Filters sheet (desktop: in place). */}
              <PhoneFilters
                active={(filter !== 'all' ? 1 : 0) + (group !== 'team' ? 1 : 0)}
                onClear={() => {
                  setFilter('all');
                  setGroup('team');
                }}
              >
                {filterKeys.length > 0 && seg('Show', filter, setFilter, FILTERS.filter(([key]) => filterKeys.includes(key)).map(([key, text, test]) => [key, text, list.filter(test).length]))}
                {teams.length > 0 && (
                  <div className="ml-auto flex items-center gap-2 text-[12px] text-t3 max-md:ml-0">
                    Group by
                    {seg<Group>('Group by', group, setGroup, [
                      ['team', 'Team'],
                      ['none', 'None'],
                    ])}
                  </div>
                )}
              </PhoneFilters>
            </div>
            )}
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
                      <AgentCard key={agent.id} agent={agent} index={i} harnessStatus={harnessByAgent.get(agent.id)} onSave={() => setSaving(agent)} onExport={() => void exportAgent(agent)} />
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
