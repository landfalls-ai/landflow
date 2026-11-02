/**
 * The Run a Team node in the editor's new look (docs/agent-teams.md#the-team-node-in-the-editor), the parts that are
 * words and data: how its panel splits the node's fields (the team picker, then "What to ask the lead", then where a
 * member's approvals go, then the rest), what the team card says, who the lead asks, and the last run in a few words.
 * Pure, so the panel and the canvas tile share it and tests read it.
 */
import type { PropertyDescriptor } from '@landflow/protocol';
import { formatTokens } from './ai-usage';
import { chartOrder, type AgentTeam, type AgentTeamConfig, type TeamMember, type TeamSummary } from './agent-teams';
import { fmtMs } from './run-trace-model';

/** The panel's sections of the node's fields; `teamId`, `teamName`, `approvalChannel` and the notice are drawn by the panel itself. */
export interface TeamPanelFields {
  /** "What to ask the lead" (the message) and the version. */
  ask: PropertyDescriptor[];
  /** Where a member's tool approvals go, drawn as choices. */
  approvals?: PropertyDescriptor;
  /** The rest, in the node's order: Slack and email settings, how long to wait. */
  rest: PropertyDescriptor[];
  /** The long notice, behind "More about how a team runs". */
  notice?: string;
}

const RELABEL: Record<string, Partial<PropertyDescriptor>> = {
  message: { displayName: 'What to ask the lead', description: 'The task for the lead; it asks its members for the parts' },
  version: { displayName: 'Which version' },
  approvalTimeoutMinutes: { displayName: 'How long to wait (minutes)', description: 'Refuse the waiting tool calls after this long; 0 waits until someone decides' },
};

/** Split the node's fields for the panel, with plainer names for the ones a person reads first. */
export function teamPanelFields(properties: readonly PropertyDescriptor[]): TeamPanelFields {
  const fields: TeamPanelFields = { ask: [], rest: [] };
  for (const p of properties) {
    if (p.name === 'teamId' || p.name === 'teamName') continue;
    if (p.type === 'notice') {
      fields.notice = p.displayName;
      continue;
    }
    if (p.name === 'approvalChannel') {
      fields.approvals = p;
      continue;
    }
    const property = RELABEL[p.name] ? ({ ...p, ...RELABEL[p.name] } as PropertyDescriptor) : p;
    (p.name === 'message' || p.name === 'version' ? fields.ask : fields.rest).push(property);
  }
  return fields;
}

/** A choice of where approvals go, in a person's words. */
export function approvalChoiceLabel(option: { name: string; value: unknown }): string {
  if (option.value === 'chat') return 'Here and in Needs you';
  return option.name;
}

/** The members of the version the node runs (`version`: published unless it says draft), in chart order. */
export function teamVersion(team: AgentTeam, version: unknown): (AgentTeamConfig & { version?: number }) | undefined {
  if (version === 'draft') return team.draft;
  return team.published ?? undefined;
}

/** Under the team's name: "Published v3 · lead and 3 members", or what stops it from running. */
export function teamCardLine(team: Pick<TeamSummary, 'members' | 'published'>, version?: unknown): string {
  const size = team.members <= 1 ? 'the lead alone' : `lead and ${team.members - 1} member${team.members === 2 ? '' : 's'}`;
  if (version === 'draft') return `Draft · ${size}`;
  if (!team.published) return 'Not published yet: publish it on its page to run it';
  return `Published v${team.published.version} · ${size}`;
}

/** The lead and the members it asks directly: "Tech Lead asks Planner, Developer, Reviewer". */
export function leadAsks(config: AgentTeamConfig): { lead?: TeamMember; asks: TeamMember[] } {
  const [lead, ...rest] = chartOrder(config);
  if (!lead) return { asks: [] };
  return { lead, asks: rest.filter((m) => m.reportsTo === lead.id) };
}

/** The titles after the lead, for the node's roster row: "Planner · Developer · Reviewer" (at most `max`, then "+2"). */
export function rosterText(titles: readonly string[], max = 4): string {
  const shown = titles.slice(0, max).join(' · ');
  return titles.length > max ? `${shown} +${titles.length - max}` : shown;
}

/** The team's last run in a few words: "Answered · 2m 25s · 22k tokens"; `outcome` from the run's line when known. */
export function lastRunWords(run: { status: string; durationMs?: number; members: ReadonlyArray<{ tokens: number }>; live?: boolean }, outcome?: string): string {
  const tokens = run.members.reduce((sum, m) => sum + (m.tokens || 0), 0);
  const how = run.live ? 'Running now' : (outcome ?? (run.status === 'error' ? 'Failed' : run.status === 'waiting' ? 'Waiting for a person' : run.status === 'canceled' ? 'Stopped' : 'Done'));
  return [how, run.durationMs !== undefined && !run.live ? fmtMs(run.durationMs) : '', tokens ? `${formatTokens(tokens)} tokens` : ''].filter(Boolean).join(' · ');
}
