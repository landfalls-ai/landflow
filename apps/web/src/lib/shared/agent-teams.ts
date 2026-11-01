/**
 * Agent teams (docs/agent-teams.md): agents with standing relations, like an org chart. One root (a Landflow agent)
 * runs the work; every other member reports to exactly one manager; managers delegate down and members report up.
 * A member can also review another's work: its manager can't report done until the reviewer signs off.
 *
 * Members are Landflow agents (`agent`, by id) or remote agents over A2A (`a2a`, e.g. Claude Code on kagent), which
 * can only be leaves: a manager runs a tool-calling loop, and only Landflow agents have one here. A flow runs a team
 * with the Run a Team node (`core.runTeam`); teams live on the Agents page (`/api/agent-teams`, table `agent_teams`).
 * Not to be confused with an agent's `team` label (a grouping on the Agents page) or Microsoft Teams channels.
 */
import type { CredentialRef } from './agents';
import type { ActorConnection } from './run-trace';

/** Where a member's questions go first: its manager (who may pass them on to a person) or straight to a person. */
export type QuestionsTo = 'manager' | 'person';

interface MemberBase {
  /** Stable within the team: `m_` + a short id. */
  id: string;
  /** "Developer", "Reviewer": shown in the chart and the run, and the name its manager calls it by. */
  title: string;
  /** What it does, in a sentence: shown under its title and given to its manager as when to ask it. */
  role?: string;
  /** The member it reports to; absent only for the root. */
  reportsTo?: string;
  /** Members whose work it must sign off before their manager reports done. */
  reviews?: string[];
  /**
   * Peers it may consult or hand its task to, without going through its manager (Landflow agents only: a remote member
   * has no tools to do it with). The peer answers the member that asked, and counts against its own budget.
   */
  consults?: string[];
  /** Tokens it may spend in one run: a warning at 80%, a stop at 100%. Absent: no limit. */
  budgetTokens?: number;
  questionsTo?: QuestionsTo;
}

export interface AgentMember extends MemberBase {
  kind: 'agent';
  agentId: string;
}

export interface RemoteMember extends MemberBase {
  kind: 'a2a';
  /** The A2A Agent node's parameters (core.a2aAgent): agentUrl, authentication, options. */
  parameters: Record<string, unknown>;
  /** httpBearerAuth or httpHeaderAuth, by the node's credential names. */
  credentials?: Record<string, CredentialRef>;
}

export type TeamMember = AgentMember | RemoteMember;

export interface AgentTeamConfig {
  name: string;
  /** What the team is for: every request inside it carries this (goal ancestry). */
  goal?: string;
  description?: string;
  members: TeamMember[];
}

export interface AgentTeam {
  id: string;
  /** The version being edited. */
  draft: AgentTeamConfig;
  /** The version flows run; absent until first published. */
  published?: AgentTeamConfig & { version: number; publishedAt: string };
  projectId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TeamSummary {
  id: string;
  name: string;
  goal?: string;
  members: number;
  /** The root's title. */
  lead?: string;
  published?: { version: number; publishedAt: string };
  /**
   * The draft's Landflow agents, for the cards' faces (the roster has them): its agent members and the agents its remote
   * members run on kagent (`memberAgent`). `remote` counts the members called over A2A.
   */
  agentIds?: string[];
  remote?: number;
  /** What stops the draft from being published, as `teamIssues` words. */
  issues?: number;
  updatedAt: string;
}

/** A member and the members reporting to it, for the chart. */
export interface OrgNode {
  member: TeamMember;
  reports: OrgNode[];
}

export const rootOf = (config: AgentTeamConfig): TeamMember | undefined => config.members.find((m) => !m.reportsTo);

/**
 * The kagent agent an A2A address calls: Landflow reaches kagent's controller at `<controller>/agents/<namespace>/<name>`
 * (`a2aUrlOf`, lib/server/kagent/cluster.ts), so the name is the segment after `/agents/<namespace>/`. Other addresses
 * name no kagent agent (undefined).
 */
export function deploymentOf(agentUrl: unknown): string | undefined {
  const path = String(agentUrl ?? '')
    .trim()
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '');
  const name = /\/agents\/[^/]+\/([^/]+)$/.exec(path)?.[1];
  return name ? decodeURIComponent(name) : undefined;
}

/**
 * The Landflow agent behind a member: an agent member's own, or the agent a remote member calls on kagent (its
 * address is that agent's on kagent's controller), so a Landflow agent run there keeps its face and name everywhere.
 */
export function memberAgent<A extends { id: string; kagent?: string }>(member: TeamMember, agents: readonly A[]): A | undefined {
  if (member.kind === 'agent') return agents.find((a) => a.id === member.agentId);
  const name = deploymentOf(member.parameters?.agentUrl);
  return name ? agents.find((a) => a.kagent === name) : undefined;
}

export const reportsOf = (config: AgentTeamConfig, memberId: string): TeamMember[] => config.members.filter((m) => m.reportsTo === memberId);

export const managerOf = (config: AgentTeamConfig, member: TeamMember): TeamMember | undefined =>
  member.reportsTo ? config.members.find((m) => m.id === member.reportsTo) : undefined;

/** The chart from the root down; undefined while the team has no single root. */
export function orgTree(config: AgentTeamConfig): OrgNode | undefined {
  const roots = config.members.filter((m) => !m.reportsTo);
  if (roots.length !== 1) return undefined;
  const seen = new Set<string>();
  const build = (member: TeamMember): OrgNode => {
    seen.add(member.id);
    return { member, reports: reportsOf(config, member.id).filter((m) => !seen.has(m.id)).map(build) };
  };
  return build(roots[0]);
}

/** Every member in chart order: the lead, then each manager's reports under it; the members' order without a single lead. */
export function chartOrder(config: AgentTeamConfig): TeamMember[] {
  const tree = orgTree(config);
  const walk = (node: OrgNode): TeamMember[] => [node.member, ...node.reports.flatMap(walk)];
  return tree ? walk(tree) : config.members;
}

/** What stops a team from running, in plain words; empty when it can run. With `agentExists`, members whose agent is gone count too. */
export function teamIssues(config: AgentTeamConfig, options: { agentExists?: (agentId: string) => boolean } = {}): string[] {
  const issues: string[] = [];
  const byId = new Map(config.members.map((m) => [m.id, m]));
  if (!config.name.trim()) issues.push('The team needs a name.');
  if (!config.members.length) issues.push('Add at least one member.');
  if (byId.size !== config.members.length) issues.push('Two members share an id.');
  const titles = config.members.map((m) => m.title.trim().toLowerCase());
  if (titles.some((t) => !t)) issues.push('Every member needs a title.');
  else if (new Set(titles).size !== titles.length) issues.push('Two members share a title: titles are how managers call them.');
  const roots = config.members.filter((m) => !m.reportsTo);
  if (config.members.length && roots.length !== 1) issues.push(roots.length ? `Only one member can lead: ${roots.map((m) => m.title).join(', ')} report to nobody.` : 'One member must lead and report to nobody.');
  for (const m of config.members) {
    if (m.reportsTo && !byId.has(m.reportsTo)) issues.push(`${m.title} reports to a member who isn't in the team.`);
    for (const r of m.reviews ?? []) {
      if (r === m.id) issues.push(`${m.title} can't review its own work.`);
      else if (!byId.has(r)) issues.push(`${m.title} reviews a member who isn't in the team.`);
    }
    for (const c of m.consults ?? []) {
      if (c === m.id) issues.push(`${m.title} can't consult itself.`);
      else if (!byId.has(c)) issues.push(`${m.title} may consult a member who isn't in the team.`);
    }
    if (m.kind === 'a2a' && m.consults?.length) issues.push(`${m.title} is a remote agent, so it can't consult anyone: only Landflow agents have tools to do it with.`);
    if (m.budgetTokens !== undefined && !(m.budgetTokens > 0)) issues.push(`${m.title}'s budget must be more than 0 tokens.`);
    if (m.kind === 'a2a' && reportsOf(config, m.id).length) issues.push(`${m.title} is a remote agent, so nobody can report to it: only Landflow agents can manage.`);
    if (m.kind === 'agent' && !m.agentId) issues.push(`Pick the agent for ${m.title}.`);
    else if (m.kind === 'agent' && options.agentExists && !options.agentExists(m.agentId)) issues.push(`${m.title}'s agent no longer exists: pick another.`);
    if (m.kind === 'a2a' && !String(m.parameters?.agentUrl ?? '').trim()) issues.push(`${m.title} needs the remote agent's address.`);
  }
  // Every reporting line ends at the root: no cycles.
  for (const m of config.members) {
    const path = new Set<string>();
    for (let at: TeamMember | undefined = m; at?.reportsTo; at = byId.get(at.reportsTo)) {
      if (path.has(at.id)) {
        issues.push(`${m.title}'s reporting line goes round in a circle.`);
        break;
      }
      path.add(at.id);
    }
  }
  return [...new Set(issues)];
}

/** A member as a run records it on the Run a Team node's span (`attrs.team`), for the Run Trace to draw the chart from the record. */
export interface TeamSnapshotMember {
  id: string;
  title: string;
  kind: TeamMember['kind'];
  role?: string;
  reportsTo?: string;
  reviews?: string[];
  consults?: string[];
  budgetTokens?: number;
  /** What it works with when the run started: model, tools, knowledge, runtime, plugins, network (lib/server/agents/connections.ts). */
  connections?: ActorConnection[];
}

export interface TeamSnapshot {
  id: string;
  name: string;
  version?: number;
  goal?: string;
  members: TeamSnapshotMember[];
}

/** The team a span's attrs record, when they record one with at least a member. */
export function teamSnapshotOf(attrs: Record<string, unknown> | undefined): TeamSnapshot | undefined {
  const team = attrs?.team as Partial<TeamSnapshot> | undefined;
  if (!team || typeof team !== 'object' || !Array.isArray(team.members)) return undefined;
  const members = team.members.filter((m): m is TeamSnapshotMember => Boolean(m) && typeof m.id === 'string' && typeof m.title === 'string');
  return members.length ? { id: String(team.id ?? ''), name: String(team.name ?? 'Team'), ...(typeof team.version === 'number' && { version: team.version }), ...(typeof team.goal === 'string' && { goal: team.goal }), members } : undefined;
}

/** A published team as Spotlight sees it: enough to propose a Run a Team node for it. */
export interface TeamBrief {
  id: string;
  name: string;
  goal?: string;
  version: number;
  /** Members by title, each with the title of the member it reports to. */
  members: Array<{ title: string; role?: string; reportsTo?: string }>;
}

export function teamBrief(team: AgentTeam): TeamBrief | undefined {
  const { published } = team;
  if (!published) return undefined;
  const title = (id?: string) => published.members.find((m) => m.id === id)?.title;
  return {
    id: team.id,
    name: published.name,
    ...(published.goal && { goal: published.goal }),
    version: published.version,
    members: published.members.map((m) => ({ title: m.title, ...(m.role && { role: m.role }), ...(m.reportsTo && { reportsTo: title(m.reportsTo) }) })),
  };
}

/** The published teams as prompt text, one line each. */
export function describeTeams(teams: TeamBrief[]): string {
  return teams
    .map((t) => `- “${t.name}” (teamId ${t.id}, v${t.version})${t.goal ? `: ${t.goal.slice(0, 120)}` : ''}. Members: ${t.members.map((m) => `${m.title}${m.reportsTo ? ` (reports to ${m.reportsTo})` : ' (lead)'}`).join(', ')}`)
    .join('\n');
}
