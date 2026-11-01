/**
 * Agent teams (docs/agent-teams.md): the `agent_teams` table (migration 1910), one row per team with its draft and its
 * published version as JSON. The draft saves whatever shape it has (issues are warnings); publishing refuses while
 * `teamIssues` finds any. A team's project is kept with the other resources' homes (kind `agentTeam`).
 */
import { nanoid } from 'nanoid';
import { memberAgent, rootOf, type QuestionsTo, teamIssues, type AgentTeam, type AgentTeamConfig, type TeamMember, type TeamSummary } from '../../shared/agent-teams';
import { agentStore } from '../agents/store';
import { database } from '../db';
import { homeProjectId } from '../projects/store';

/** What stops a draft from running, members whose agent was deleted included. */
export const issuesOf = (config: AgentTeamConfig): string[] => teamIssues(config, { agentExists: (id) => Boolean(agentStore.get(id)) });

export class AgentTeamError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
  }
}

interface Row {
  id: string;
  name: string;
  draft: string;
  published: string | null;
  version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

const COLUMNS = 'id, name, draft, published, version, created_by, created_at, updated_at';

const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

function cleanMember(input: unknown): TeamMember | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const m = input as Record<string, unknown>;
  const id = text(m.id, 40);
  if (!id) return undefined;
  const reviews = Array.isArray(m.reviews) ? [...new Set(m.reviews.filter((r): r is string => typeof r === 'string'))] : [];
  const consults = Array.isArray(m.consults) ? [...new Set(m.consults.filter((r): r is string => typeof r === 'string'))] : [];
  const role = text(m.role, 500);
  const budget = typeof m.budgetTokens === 'number' && Number.isFinite(m.budgetTokens) ? Math.floor(m.budgetTokens) : undefined;
  const base = {
    id,
    title: text(m.title, 80),
    ...(role && { role }),
    ...(typeof m.reportsTo === 'string' && m.reportsTo && { reportsTo: m.reportsTo }),
    ...(reviews.length && { reviews }),
    ...(consults.length && { consults }),
    ...(budget !== undefined && { budgetTokens: budget }),
    ...((m.questionsTo === 'manager' || m.questionsTo === 'person') && { questionsTo: m.questionsTo as QuestionsTo }),
  };
  if (m.kind === 'agent') return { ...base, kind: 'agent', agentId: text(m.agentId, 100) };
  if (m.kind === 'a2a') {
    const parameters = m.parameters && typeof m.parameters === 'object' && !Array.isArray(m.parameters) ? (m.parameters as Record<string, unknown>) : {};
    const credentials = m.credentials && typeof m.credentials === 'object' && !Array.isArray(m.credentials) ? (m.credentials as Record<string, never>) : undefined;
    return { ...base, kind: 'a2a', parameters, ...(credentials && Object.keys(credentials).length && { credentials }) };
  }
  return undefined;
}

/** A complete config from whatever the editor sent: unknown members and fields are dropped, text trimmed. */
export function cleanConfig(input: Partial<AgentTeamConfig> | undefined): AgentTeamConfig {
  const goal = text(input?.goal, 1000);
  const description = text(input?.description, 1000);
  return {
    name: text(input?.name, 200),
    ...(goal && { goal }),
    ...(description && { description }),
    members: (Array.isArray(input?.members) ? input.members : []).map(cleanMember).filter((m): m is TeamMember => Boolean(m)).slice(0, 50),
  };
}

function revive(row: Row): AgentTeam {
  const published = row.published ? (JSON.parse(row.published) as AgentTeam['published']) : undefined;
  const projectId = homeProjectId('agentTeam', row.id);
  return {
    id: row.id,
    draft: JSON.parse(row.draft) as AgentTeamConfig,
    ...(published && { published }),
    ...(projectId && { projectId }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function summarize(team: AgentTeam, onKagent: Array<{ id: string; kagent?: string }>): TeamSummary {
  const { draft } = team;
  const agentIds = draft.members.flatMap((m) => (m.kind === 'agent' ? (m.agentId ? [m.agentId] : []) : (memberAgent(m, onKagent)?.id ?? [])));
  return {
    id: team.id,
    name: draft.name || 'Untitled team',
    ...(draft.goal && { goal: draft.goal }),
    members: draft.members.length,
    ...(rootOf(draft) && { lead: rootOf(draft)!.title }),
    ...(team.published && { published: { version: team.published.version, publishedAt: team.published.publishedAt } }),
    agentIds,
    remote: draft.members.filter((m) => m.kind === 'a2a').length,
    issues: issuesOf(draft).length,
    updatedAt: team.updatedAt,
  };
}

export const agentTeamStore = {
  list(): AgentTeam[] {
    return database().all<Row>(`SELECT ${COLUMNS} FROM agent_teams ORDER BY updated_at DESC`).map(revive);
  },
  summaries(): TeamSummary[] {
    // Remote members that call a Landflow agent on kagent show that agent's face.
    const onKagent = agentStore.list().flatMap((a) => (a.kagent ? [{ id: a.id, kagent: a.kagent.name }] : []));
    return this.list().map((team) => summarize(team, onKagent));
  },
  get(id: string): AgentTeam | undefined {
    const row = database().get<Row>(`SELECT ${COLUMNS} FROM agent_teams WHERE id = ?`, id);
    return row ? revive(row) : undefined;
  },
  create(input: Partial<AgentTeamConfig> = {}, createdBy?: string): AgentTeam {
    const now = new Date().toISOString();
    const draft = cleanConfig({ ...input, name: input.name?.trim() || 'Untitled team' });
    const row: Row = { id: `team_${nanoid(10)}`, name: draft.name, draft: JSON.stringify(draft), published: null, version: 0, created_by: createdBy ?? null, created_at: now, updated_at: now };
    database().upsert('agent_teams', { ...row });
    return revive(row);
  },
  /** Replace the draft. Whatever its shape: `teamIssues` only stops publishing. */
  saveDraft(id: string, config: Partial<AgentTeamConfig>): AgentTeam | undefined {
    const row = database().get<Row>(`SELECT ${COLUMNS} FROM agent_teams WHERE id = ?`, id);
    if (!row) return undefined;
    const draft = cleanConfig(config);
    const next: Row = { ...row, name: draft.name || row.name, draft: JSON.stringify({ ...draft, name: draft.name || row.name }), updated_at: new Date().toISOString() };
    database().upsert('agent_teams', { ...next });
    return revive(next);
  },
  /** Snapshot the draft as the next version. Throws AgentTeamError (with the issues) while the draft can't run. */
  publish(id: string): AgentTeam | undefined {
    const row = database().get<Row>(`SELECT ${COLUMNS} FROM agent_teams WHERE id = ?`, id);
    if (!row) return undefined;
    const draft = JSON.parse(row.draft) as AgentTeamConfig;
    const issues = issuesOf(draft);
    if (issues.length) throw new AgentTeamError('Fix these before publishing', issues);
    const now = new Date().toISOString();
    const version = row.version + 1;
    const next: Row = { ...row, version, published: JSON.stringify({ ...draft, version, publishedAt: now }), updated_at: now };
    database().upsert('agent_teams', { ...next });
    return revive(next);
  },
  /** Stop flows from running it; the version number keeps counting. */
  unpublish(id: string): AgentTeam | undefined {
    const row = database().get<Row>(`SELECT ${COLUMNS} FROM agent_teams WHERE id = ?`, id);
    if (!row) return undefined;
    const next: Row = { ...row, published: null, updated_at: new Date().toISOString() };
    database().upsert('agent_teams', { ...next });
    return revive(next);
  },
  delete(id: string): boolean {
    return database().delete('agent_teams', { id }) > 0;
  },
  /** The teams an agent is a member of, in the draft or the published version. */
  teamsOfAgent(agentId: string): Array<{ id: string; name: string; title: string }> {
    return this.list().flatMap((team) => {
      const member = [...team.draft.members, ...(team.published?.members ?? [])].find((m) => m.kind === 'agent' && m.agentId === agentId);
      return member ? [{ id: team.id, name: team.draft.name, title: member.title }] : [];
    });
  },
};
