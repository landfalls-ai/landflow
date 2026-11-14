'use client';
/**
 * The Run a Team node's panel in the new look (docs/agent-teams.md#the-team-node-in-the-editor): the team as a card with
 * its faces, who is on it (a row per member, from the team page's cards), "What to ask the lead", where a member's
 * approvals go as choices, how the team runs as a small picture, and the team's last run in one line. With no team chosen
 * it shows the teams as cards to tap. Slack and email settings and the wait stay the usual form, under the choices.
 */
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowUpRight, Check, Plus } from 'lucide-react';
import type { PropertyDescriptor } from '@landflow/protocol';
import { api } from '@/lib/client/api';
import { chartOrder, memberAgent, type AgentTeam, type TeamSummary } from '@/lib/shared/agent-teams';
import type { AgentSummary } from '@/lib/shared/agents';
import { formatTokens } from '@/lib/shared/ai-usage';
import { DevOnly } from '@/lib/client/developer-details';
import { approvalChoiceLabel, lastRunWords, leadAsks, teamCardLine, teamPanelFields, teamVersion } from '@/lib/shared/team-node';
import { cn } from '@/lib/utils';
import { AgentAvatar, type AvatarSource } from '../agents/avatar';
import { faceOf, loadRoster, loadTeam } from '../agents/faces';
import { lastTurn, runsOnLabel } from '../agents/member-cards';
import { useLastTeamRun } from '../agents/team-run-data';
import { Chip } from '../ui/badge';
import { RunLineRow, useRunLines } from '../run-trace/run-line';
import { ParamForm } from './param-form';
import { memberFace } from './team-live';

type Values = Record<string, unknown>;
type FormProps = Omit<Parameters<typeof ParamForm>[0], 'properties' | 'values' | 'onChange' | 'nodeType'>;

function Section({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <section className={className} aria-label={label}>
      <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-t3">{label}</h3>
      {children}
    </section>
  );
}

function useRoster(): AgentSummary[] {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  useEffect(() => {
    let live = true;
    void loadRoster().then((a) => live && setAgents(a));
    return () => {
      live = false;
    };
  }, []);
  return agents;
}

/** The teams to choose from, read again when the window comes back (a team made in another tab). */
function useTeamSummaries(): TeamSummary[] | undefined {
  const [teams, setTeams] = useState<TeamSummary[]>();
  useEffect(() => {
    let live = true;
    const read = () => void api<{ teams: TeamSummary[] }>('/api/agent-teams').then((r) => live && setTeams(r.teams ?? []), () => live && setTeams((t) => t ?? []));
    read();
    window.addEventListener('focus', read);
    return () => {
      live = false;
      window.removeEventListener('focus', read);
    };
  }, []);
  return teams;
}

function useTeam(teamId: string): AgentTeam | null | undefined {
  const [team, setTeam] = useState<AgentTeam | null>();
  useEffect(() => {
    let live = true;
    setTeam(undefined);
    void loadTeam(teamId).then((t) => live && setTeam(t ?? null));
    return () => {
      live = false;
    };
  }, [teamId]);
  return team;
}

/** The lead's face large, the others small and overlapping. */
function FaceStack({ faces, size = 34 }: { faces: AvatarSource[]; size?: number }) {
  const small = Math.round(size * 0.66);
  return (
    <span className="flex shrink-0 items-end">
      {faces.slice(0, 5).map((face, i) => (
        <AgentAvatar key={i} agent={face} size={i ? small : size} round className={cn(i && '-ml-2 ring-2 ring-sf')} />
      ))}
    </span>
  );
}

function summaryFaces(team: TeamSummary, roster: AgentSummary[]): AvatarSource[] {
  const byId = new Map(roster.map((a) => [a.id, a]));
  return (team.agentIds ?? []).flatMap((id) => (byId.get(id) ? [faceOf(byId.get(id)!)] : []));
}

function TeamChoices({ teams, roster, current, onPick, onCancel }: { teams?: TeamSummary[]; roster: AgentSummary[]; current?: string; onPick: (team: TeamSummary) => void; onCancel?: () => void }) {
  if (!teams) return <div className="h-[64px] animate-pulse-soft rounded-2xl border border-hair bg-sf" />;
  return (
    <div className="flex flex-col gap-1.5" data-testid="team-choices">
      {!teams.length && <p className="text-[12px] text-t3">No teams yet. Make one on the Agents page, then pick it here.</p>}
      {teams.map((team) => {
        const faces = summaryFaces(team, roster);
        return (
          <button
            key={team.id}
            type="button"
            onClick={() => onPick(team)}
            className={cn('flex items-center gap-3 rounded-2xl border bg-sf p-2.5 text-left transition-colors hover:border-bd hover:bg-acdim/40', team.id === current ? 'border-ac' : 'border-hair')}
          >
            {faces.length ? <FaceStack faces={faces} size={30} /> : <span className="grid size-[30px] shrink-0 place-items-center rounded-full bg-acdim text-[13px] font-semibold text-t2">{team.name.charAt(0)}</span>}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-t1">{team.name}</span>
              <span className="block truncate text-[12px] text-t3">{team.goal || teamCardLine(team)}</span>
            </span>
            {team.id === current && <Check className="size-4 shrink-0 text-ac" />}
          </button>
        );
      })}
      <div className="flex items-center gap-3">
        <Link href="/agents?view=teams" target="_blank" className="flex flex-1 items-center justify-center gap-1.5 rounded-2xl border border-dashed border-bd p-2.5 text-[12px] font-semibold text-t2 hover:border-ac hover:text-ac">
          <Plus className="size-3.5" /> New team <ArrowUpRight className="size-3" />
        </Link>
        {onCancel && (
          <button type="button" onClick={onCancel} className="px-2 text-[12px] font-medium text-t3 hover:text-t1">
            Keep this team
          </button>
        )}
      </div>
    </div>
  );
}

function TeamCard({ team, teamId, version, faces, onChange }: { team: AgentTeam | null | undefined; teamId: string; version: unknown; faces: AvatarSource[]; onChange: () => void }) {
  const config = team ? (teamVersion(team, version) ?? team.draft) : undefined;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-hair bg-sf p-2.5" data-testid="team-card">
      {faces.length ? <FaceStack faces={faces} /> : <span className="size-[34px] shrink-0 animate-pulse-soft rounded-full bg-acdim" />}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-semibold text-t1">{config?.name ?? (team === null ? 'This team is gone' : '…')}</span>
        <span className={cn('block truncate text-[12px]', team && !team.published && version !== 'draft' ? 'text-warn' : 'text-t3')}>
          {team && config ? teamCardLine({ members: config.members.length, published: team.published }, version) : team === null ? 'Pick another team' : ' '}
        </span>
      </span>
      <span className="flex shrink-0 gap-1.5">
        <button type="button" onClick={onChange} className="h-7 rounded-full border border-hair px-2.5 text-[12px] font-semibold text-t1 hover:border-bd">
          Change
        </button>
        {team && (
          <Link href={`/agents/teams/${teamId}`} target="_blank" className="flex h-7 items-center gap-0.5 rounded-full border border-hair px-2.5 text-[12px] font-semibold text-t1 hover:border-bd">
            Open <ArrowUpRight className="size-3" />
          </Link>
        )}
      </span>
    </div>
  );
}

function MemberRows({ team, version, roster, teamId }: { team: AgentTeam; version: unknown; roster: AgentSummary[]; teamId: string }) {
  const run = useLastTeamRun(teamId);
  const config = teamVersion(team, version) ?? team.draft;
  const members = chartOrder(config);
  if (!members.length) return <p className="text-[12px] text-t3">No members yet: add them on the team's page.</p>;
  return (
    <ul className="overflow-hidden rounded-2xl border border-hair bg-sf" data-testid="team-member-rows">
      {members.map((member, i) => {
        const agent = memberAgent(member, roster);
        const line = agent?.whatIDo?.[0] ?? member.role;
        const runsOn = runsOnLabel(member, agent);
        const turn = lastTurn(run, member.title);
        return (
          <li key={member.id} className={cn('flex items-start gap-2.5 px-3 py-2.5', i && 'border-t border-hair')} data-member={member.title}>
            <AgentAvatar agent={memberFace(member, roster)} size={30} round />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-[13px] font-semibold text-t1">{member.title || 'Untitled'}</span>
                {i === 0 && <span className="rounded-full bg-acdim px-1.5 py-px text-[10px] font-bold text-t2">Lead</span>}
              </div>
              {line && <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-t2">{line}</p>}
              {(runsOn || member.budgetTokens !== undefined || turn) && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {runsOn && (
                    <DevOnly>
                      <Chip tone="accent">{runsOn}</Chip>
                    </DevOnly>
                  )}
                  {member.budgetTokens !== undefined && <Chip>{formatTokens(member.budgetTokens)} a run</Chip>}
                  {turn && <Chip tone={turn.startsWith('Over') ? 'danger' : 'muted'}>{turn}</Chip>}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function ApprovalChoices({ property, value, onPick }: { property: PropertyDescriptor; value: unknown; onPick: (value: unknown) => void }) {
  const options = (property.options ?? []) as Array<{ name: string; value: unknown; description?: string }>;
  const current = value ?? property.default;
  const chosen = options.find((o) => o.value === current);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Where a member’s approvals go">
        {options.map((option) => {
          const on = option.value === current;
          return (
            <button
              key={String(option.value)}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onPick(option.value)}
              className={cn('h-8 rounded-full border px-3 text-[12px] font-medium transition-colors', on ? 'border-ac2 bg-ac2 text-on-ac' : 'border-hair text-t2 hover:border-bd hover:text-t1')}
            >
              {approvalChoiceLabel(option)}
            </button>
          );
        })}
      </div>
      {chosen?.description && <p className="mt-1.5 text-[12px] text-t3">{chosen.description}</p>}
    </div>
  );
}

function HowItRuns({ team, version, roster, notice }: { team: AgentTeam; version: unknown; roster: AgentSummary[]; notice?: string }) {
  const { lead, asks } = leadAsks(teamVersion(team, version) ?? team.draft);
  const box = 'flex items-center gap-1.5 whitespace-nowrap rounded-xl border border-hair bg-sf px-2 py-1.5 text-[12px] text-t2';
  return (
    <div>
      <div className="flex flex-wrap items-center gap-1.5" data-testid="team-how">
        <span className={box}>Message</span>
        <ArrowRight className="size-3 text-t3" aria-hidden />
        <span className={cn(box, 'min-w-0 whitespace-normal')}>
          {lead && <AgentAvatar agent={memberFace(lead, roster)} size={18} round />}
          <span>
            <b className="font-semibold text-t1">{lead?.title ?? 'The lead'}</b> asks {asks.length ? asks.map((m) => m.title).join(', ') : 'its members'}
          </span>
        </span>
        <ArrowRight className="size-3 text-t3" aria-hidden />
        <span className="flex flex-col gap-1">
          <span className={cn(box, 'border-gnbd text-gn')}>Done · reply and usage</span>
          <span className={cn(box, 'border-warnbd text-warn')}>Needs a person · why</span>
        </span>
      </div>
      {notice && (
        <details className="mt-2 text-[12px] text-t3">
          <summary className="cursor-pointer select-none font-medium hover:text-t1">More about how a team runs</summary>
          <p className="mt-1.5 leading-relaxed">{notice}</p>
        </details>
      )}
    </div>
  );
}

function LastRun({ teamId }: { teamId: string }) {
  const run = useLastTeamRun(teamId);
  const lines = useRunLines(run ? [run.executionId] : []);
  if (!run) return null;
  const line = lines?.[run.executionId];
  const open = () => window.open(`/runs/${run.executionId}`, '_blank');
  return (
    <Section label={`Last run · ${run.workflowName}`}>
      {line ? (
        <RunLineRow line={line} onOpen={open} startedAt={run.startedAt} />
      ) : (
        <button type="button" onClick={open} className="w-full rounded-2xl border border-hair bg-sf px-3 py-2.5 text-left text-[12px] text-t2 hover:border-bd">
          {lastRunWords(run)}
        </button>
      )}
    </Section>
  );
}

/** The faces of the version the node runs, the lead first. */
function useChosenTeamFaces(team: AgentTeam | null | undefined, version: unknown, roster: AgentSummary[]): AvatarSource[] {
  return useMemo(() => (team ? chartOrder(teamVersion(team, version) ?? team.draft).map((m) => memberFace(m, roster)) : []), [team, version, roster]);
}

export function TeamNodePanel({ properties, values, onChange, form }: { properties: PropertyDescriptor[]; values: Values; onChange: (values: Values) => void; form: FormProps }) {
  const fields = useMemo(() => teamPanelFields(properties), [properties]);
  const teamId = typeof values.teamId === 'string' ? values.teamId : '';
  const [choosing, setChoosing] = useState(false);
  const roster = useRoster();
  const teams = useTeamSummaries();
  const team = useTeam(teamId);
  const faces = useChosenTeamFaces(team, values.version, roster);
  const expression = teamId.startsWith('=') || teamId.includes('{{');

  return (
    <div className="space-y-5" data-testid="team-node-panel">
      <Section label={teamId ? 'Team' : 'Team · choose one'}>
        {teamId && !choosing ? (
          expression ? (
            <p className="rounded-2xl border border-hair bg-sf px-3 py-2.5 text-[12px] text-t2">
              The team comes from an expression<DevOnly>: <code className="font-mono text-[11px]">{teamId}</code></DevOnly>
            </p>
          ) : (
            <TeamCard team={team} teamId={teamId} version={values.version} faces={faces} onChange={() => setChoosing(true)} />
          )
        ) : (
          <TeamChoices
            teams={teams}
            roster={roster}
            current={teamId || undefined}
            onPick={(t) => {
              onChange({ ...values, teamId: t.id, teamName: t.name });
              setChoosing(false);
            }}
            onCancel={teamId ? () => setChoosing(false) : undefined}
          />
        )}
      </Section>
      {teamId && team && !choosing && (
        <Section label="Who is on it">
          <MemberRows team={team} version={values.version} roster={roster} teamId={teamId} />
        </Section>
      )}
      <ParamForm {...form} nodeType="core.runTeam" properties={fields.ask} values={values} onChange={onChange} />
      {fields.approvals && (
        <Section label="When a member needs a person">
          <ApprovalChoices property={fields.approvals} value={values.approvalChannel} onPick={(v) => onChange({ ...values, approvalChannel: v })} />
        </Section>
      )}
      <ParamForm {...form} nodeType="core.runTeam" properties={fields.rest} values={values} onChange={onChange} />
      {team && !choosing && (
        <Section label="How it runs">
          <HowItRuns team={team} version={values.version} roster={roster} notice={fields.notice} />
        </Section>
      )}
      {teamId && !expression && !choosing && <LastRun teamId={teamId} />}
    </div>
  );
}
