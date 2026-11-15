/**
 * The AI page's report (docs/llm-gateway.md, "The AI page"): spend and tokens for a period by project, agent, person,
 * model and source, the caps and how near each is, the cap-raise requests and whether asking for more is on.
 *
 * Visibility: owners and admins see every row. Anyone else sees a row when they can read its workflow or agent, or it
 * is their own; a row they can't see is in no total and its project, goal, agent or workflow is "Another ...". The
 * person group is the exception (the user's decision D1, 2026-11-15): every member sees every person's spend by name,
 * from every row of the period, in `peopleTotals`. Other people's caps stay private (`capsFor`).
 */
import { agentStore } from '../agents/store';
import { watchedCaps } from '../ai-usage/alerts';
import { getUser } from '../auth/users';
import { database } from '../db';
import { productionWorkflowById } from '../publish';
import { canResource, isInstanceAdmin, projectRole, visibleIds, visibleProjectIds } from '../projects/access';
import type { Actor } from '../projects/access';
import { getGoal } from '../goals/store';
import { visibleGoals } from '../goals/views';
import { getProject, homeProjectId } from '../projects/store';
import { aiUsageMeter } from '../ai-usage';
import { store } from '../store';
import {
  backstopBudget,
  parseCapId,
  type AiConsoleCap,
  type AiConsoleGroup,
  type AiConsolePeriod,
  type AiConsoleReport,
  type AiConsoleRow,
  type AiConsoleTotals,
  type CapRaiseRequest,
  type CapRaiseSetup,
  type CapRaiseStatus,
  type GatewayBudget,
} from '../../shared/llm-gateway';
import { gatewaySettings } from './settings';

const DAY_MS = 86_400_000;
const GROUP_LIMIT = 50;
const PERIOD_DAYS: Record<AiConsolePeriod, number> = { '24h': 1, '7d': 7, '30d': 30 };

interface UsageRow {
  project_id: string | null;
  goal_id: string | null;
  agent_id: string | null;
  user_id: string | null;
  workflow_id: string | null;
  provider: string;
  model: string;
  source: string | null;
  runtime: string | null;
  input: number | null;
  output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  cost: number | null;
  calls: number | null;
}

const emptyTotals = (): AiConsoleTotals => ({ inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 });

function add(into: AiConsoleTotals, row: UsageRow) {
  into.inputTokens += Number(row.input ?? 0);
  into.outputTokens += Number(row.output ?? 0);
  const read = Number(row.cache_read ?? 0);
  const write = Number(row.cache_write ?? 0);
  if (read) into.cacheReadTokens = (into.cacheReadTokens ?? 0) + read;
  if (write) into.cacheWriteTokens = (into.cacheWriteTokens ?? 0) + write;
  into.cost += Number(row.cost ?? 0);
  into.calls += Number(row.calls ?? 0);
}

const SOURCE_LABELS: Record<string, string> = {
  'landflow:landflow': 'Landflow',
  'litellm:kagent': 'kagent',
  'litellm:claude': 'Claude Code on kagent',
  'litellm:other': 'Other clients of the gateway',
};

/**
 * `landflow:landflow`, or `litellm:<kagent|claude|other>`: a row without a source is Landflow's own, and so is an
 * imported row of runtime `landflow` (a call Landflow made outside a usage scope on the server's gateway key).
 */
export function sourceKey(source: string | null | undefined, runtime: string | null | undefined): string {
  if (source !== 'litellm' || runtime === 'landflow') return 'landflow:landflow';
  return runtime === 'kagent' || runtime === 'claude' ? `litellm:${runtime}` : 'litellm:other';
}

function periodRange(period: AiConsolePeriod, now: number): { from: string; to: string; clause: string; params: string[] } {
  const to = new Date(now).toISOString();
  if (period === '24h') {
    const from = new Date(now - DAY_MS).toISOString();
    return { from, to, clause: 'at >= ? AND at <= ?', params: [from, to] };
  }
  const meter = aiUsageMeter();
  const day = meter.today(now - (PERIOD_DAYS[period] - 1) * DAY_MS);
  return { from: day, to, clause: 'day >= ? AND day <= ?', params: [day, meter.today(now)] };
}

/** The rows of the period, summed per distinct combination of the columns the groups need (a few hundred at most). */
function usageRows(period: AiConsolePeriod, now: number): { rows: UsageRow[]; from: string; to: string } {
  const range = periodRange(period, now);
  const rows = database().all<UsageRow>(
    `SELECT project_id, goal_id, agent_id, user_id, workflow_id, provider, model, source, runtime,
       COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
       COALESCE(SUM(cache_read_tokens), 0) AS cache_read, COALESCE(SUM(cache_write_tokens), 0) AS cache_write,
       COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS calls
     FROM ai_usage WHERE ${range.clause}
     GROUP BY project_id, goal_id, agent_id, user_id, workflow_id, provider, model, source, runtime`,
    ...range.params,
  );
  return { rows, from: range.from, to: range.to };
}

const userLabel = (id: string) => getUser(id)?.name || getUser(id)?.email || 'Someone';

/**
 * A person's label in the person group, which every member sees (D1): the name. A person with no name, or whose name is
 * their email address (as a sign-in without a display name leaves it), shows the email to admins and to themselves, and as
 * "Unnamed person" to everyone else: a member never sees another person's email here.
 */
function personLabel(id: string, viewer: { id: string }, admin: boolean): string {
  const user = getUser(id);
  if (!user) return 'Someone';
  const name = user.name?.trim();
  if (admin || id === viewer.id) return name || user.email || 'Someone';
  return name && !name.includes('@') ? name : 'Unnamed person';
}

/** Sorted by cost then tokens, each with its share, the tail beyond 50 rolled into "Other". */
function finish(groups: Map<string, AiConsoleRow>, total: AiConsoleTotals): AiConsoleRow[] {
  const byCost = total.cost > 0;
  const whole = byCost ? total.cost : total.inputTokens + total.outputTokens;
  const sorted = [...groups.values()].sort((a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens) || a.label.localeCompare(b.label));
  const shareOf = (row: AiConsoleTotals) => (whole > 0 ? (byCost ? row.cost : row.inputTokens + row.outputTokens) / whole : 0);
  const out = sorted.slice(0, GROUP_LIMIT).map((row) => ({ ...row, share: shareOf(row) }));
  if (sorted.length > GROUP_LIMIT) {
    const rest = emptyTotals();
    for (const row of sorted.slice(GROUP_LIMIT)) {
      rest.inputTokens += row.inputTokens;
      rest.outputTokens += row.outputTokens;
      rest.cost += row.cost;
      rest.calls += row.calls;
      if (row.cacheReadTokens) rest.cacheReadTokens = (rest.cacheReadTokens ?? 0) + row.cacheReadTokens;
      if (row.cacheWriteTokens) rest.cacheWriteTokens = (rest.cacheWriteTokens ?? 0) + row.cacheWriteTokens;
    }
    out.push({ ...rest, key: 'other', label: 'Other', share: shareOf(rest) });
  }
  return out;
}

function bump(groups: Map<string, AiConsoleRow>, key: string, label: string, row: UsageRow, href?: string) {
  let entry = groups.get(key);
  if (!entry) {
    entry = { ...emptyTotals(), key, label, share: 0, ...(href && { href }) };
    groups.set(key, entry);
  }
  add(entry, row);
}

function openRequestIds(userId: string): Map<string, string> {
  const rows = database().all<{ id: string; cap_id: string }>(`SELECT id, cap_id FROM ai_cap_requests WHERE requested_by = ? AND status IN ('pending', 'asking') ORDER BY created_at`, userId);
  return new Map(rows.map((row) => [row.cap_id, row.id]));
}

interface CapRequestRow {
  id: string;
  cap_id: string;
  subject: string;
  metric: string;
  period: string;
  current_max: number;
  requested_max: number;
  reason: string;
  requested_by: string;
  status: string;
  workflow_id: string | null;
  execution_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  note: string | null;
  gateway: string | null;
  created_at: string;
  updated_at: string;
}

function requestsFor(actor: Actor, admin: boolean, now: number): CapRaiseRequest[] {
  const since = new Date(now - 30 * DAY_MS).toISOString();
  const rows = admin
    ? database().all<CapRequestRow>('SELECT * FROM ai_cap_requests WHERE created_at >= ? ORDER BY created_at DESC LIMIT 20', since)
    : database().all<CapRequestRow>('SELECT * FROM ai_cap_requests WHERE created_at >= ? AND requested_by = ? ORDER BY created_at DESC LIMIT 20', since, actor.id);
  return rows.map((row): CapRaiseRequest => {
    const requestedByName = admin || row.requested_by === actor.id ? userLabel(row.requested_by) : undefined;
    const decidedByName = row.decided_by ? userLabel(row.decided_by) : undefined;
    return {
      id: row.id,
      capId: row.cap_id,
      subject: row.subject,
      metric: row.metric as CapRaiseRequest['metric'],
      period: row.period as CapRaiseRequest['period'],
      current: Number(row.current_max),
      requested: Number(row.requested_max),
      reason: row.reason,
      requestedBy: row.requested_by,
      ...(requestedByName && { requestedByName }),
      status: row.status as CapRaiseStatus,
      ...(row.workflow_id && { workflowId: row.workflow_id }),
      ...(row.execution_id && { executionId: row.execution_id }),
      ...(row.decided_by && { decidedBy: row.decided_by }),
      ...(decidedByName && { decidedByName }),
      ...(row.decided_at && { decidedAt: row.decided_at }),
      ...(row.note && { note: row.note }),
      ...(row.gateway && { gateway: row.gateway as CapRaiseRequest['gateway'] }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

/** The cap-raise flow's workflow (settings key `ai_cap_raise`) and whether it is published and switched on. */
export function capRaiseSetup(): CapRaiseSetup {
  let workflowId: string | undefined;
  try {
    const raw = database().get<{ value: string }>('SELECT value FROM settings WHERE key = ?', 'ai_cap_raise')?.value;
    const parsed = raw ? (JSON.parse(raw) as { workflowId?: unknown }) : undefined;
    if (typeof parsed?.workflowId === 'string' && parsed.workflowId) workflowId = parsed.workflowId;
  } catch {
    workflowId = undefined;
  }
  if (!workflowId) return { active: false };
  // `productionWorkflowById` is undefined for a workflow that is missing, not active (its trigger is off) or not published.
  return { workflowId, active: Boolean(productionWorkflowById(workflowId)) };
}

function capsFor(actor: Actor, admin: boolean): AiConsoleCap[] {
  const settings = gatewaySettings();
  const pending = admin ? new Map<string, string>() : openRequestIds(actor.id);
  const all = watchedCaps();
  const caps: AiConsoleCap[] = [];
  const flowOn = once(() => capRaiseSetup().active);
  for (const cap of all) {
    const parsed = parseCapId(cap.id);
    if (!parsed) continue;
    let visible = admin;
    let canWrite = false;
    if (!admin) {
      if (parsed.kind === 'user') {
        visible = parsed.subjectId === actor.id;
        canWrite = visible;
      } else if (parsed.kind === 'workflow' || parsed.kind === 'agent') {
        visible = canResource(actor, parsed.kind, parsed.subjectId, 'read');
        canWrite = visible && canResource(actor, parsed.kind, parsed.subjectId, 'update');
      } else if (parsed.kind === 'project') {
        // PC14: a project's budget is visible to its members; its editors who are not admins may ask for more while the flow is on.
        const role = projectRole(actor, parsed.subjectId);
        visible = Boolean(role);
        canWrite = role === 'editor' && flowOn();
      }
    }
    if (!visible) continue;
    // The backstop LiteLLM would hold: people and agents have one (a customer's and a key's budget), in dollars.
    let backstop: GatewayBudget | undefined;
    if (admin && settings.sync && cap.metric === 'cost' && (parsed.kind === 'user' || parsed.kind === 'agent')) {
      const siblings = (period: 'day' | 'month') => all.find((c) => c.id === `${parsed.kind}:${parsed.subjectId}:${period}:cost`)?.max;
      const budget = backstopBudget({ dayCost: siblings('day'), monthCost: siblings('month') }, parsed.kind === 'agent' ? 0 : settings.headroomPercent);
      if (budget && budget.duration === (cap.period === 'day' ? '1d' : '30d')) backstop = budget;
    }
    const pendingRequestId = pending.get(cap.id);
    caps.push({
      id: cap.id,
      subject: cap.subject,
      period: cap.period,
      metric: cap.metric,
      max: cap.max,
      used: cap.used,
      ratio: cap.max > 0 ? cap.used / cap.max : 0,
      setIn: cap.setIn,
      link: cap.link,
      canRequest: !admin && canWrite,
      ...(pendingRequestId && { pendingRequestId }),
      ...(backstop && { backstop }),
    });
  }
  return caps.sort((a, b) => b.ratio - a.ratio);
}

export function aiConsoleReport(actor: Actor, period: AiConsolePeriod, now = Date.now()): AiConsoleReport {
  const admin = isInstanceAdmin(actor);
  const { rows, from, to } = usageRows(period, now);
  const workflows = admin ? undefined : visibleIds(actor, 'workflow', store.listWorkflows().map((w) => w.id));
  const agents = admin ? undefined : visibleIds(actor, 'agent', agentStore.list().map((a) => a.id));
  const projects = admin ? undefined : visibleProjectIds(actor);
  const visibleRows = admin
    ? rows
    : rows.filter((row) => row.user_id === actor.id || Boolean(row.workflow_id && workflows?.has(row.workflow_id)) || Boolean(row.agent_id && agents?.has(row.agent_id)));

  // One lookup per distinct goal: the goal if the viewer sees it, null if not, undefined if it is gone.
  const goals = new Map<string, { id: string; title: string } | null | undefined>();
  const goalFor = (id: string) => {
    if (!goals.has(id)) {
      const goal = getGoal(id);
      goals.set(id, goal && (visibleGoals(actor, [goal], projects)[0] ?? null));
    }
    return goals.get(id);
  };

  const totals = emptyTotals();
  // SP20: the person group covers every row, whoever the viewer is (D1).
  const peopleTotals = emptyTotals();
  const groups: Record<AiConsoleGroup, Map<string, AiConsoleRow>> = { project: new Map(), goal: new Map(), agent: new Map(), person: new Map(), model: new Map(), source: new Map() };
  for (const row of rows) {
    add(peopleTotals, row);
    if (!row.user_id) bump(groups.person, 'none', 'No person', row);
    else bump(groups.person, row.user_id, personLabel(row.user_id, actor, admin), row);
  }
  for (const row of visibleRows) {
    add(totals, row);
    const projectId = row.project_id || (row.workflow_id ? homeProjectId('workflow', row.workflow_id) : row.agent_id ? homeProjectId('agent', row.agent_id) : undefined);
    const project = projectId ? getProject(projectId) : undefined;
    if (!project) bump(groups.project, 'none', 'No project', row);
    else if (projects && !projects.has(project.id)) bump(groups.project, 'shared', 'Another project', row);
    else bump(groups.project, project.id, project.name, row);

    if (!row.goal_id) bump(groups.goal, 'none', 'No goal', row);
    else {
      const goal = goalFor(row.goal_id);
      if (goal === undefined) bump(groups.goal, row.goal_id, 'Deleted goal', row);
      else if (goal === null) bump(groups.goal, 'shared', 'Another goal', row);
      else bump(groups.goal, goal.id, goal.title, row);
    }

    const agent = row.agent_id ? agentStore.get(row.agent_id) : undefined;
    if (!row.agent_id) bump(groups.agent, 'none', 'No agent', row);
    else if (agents && !agents.has(row.agent_id)) bump(groups.agent, 'shared', 'Another agent', row);
    else bump(groups.agent, row.agent_id, agent?.name ?? 'Deleted agent', row, agent ? `/agents/${row.agent_id}` : undefined);

    bump(groups.model, `${row.provider}/${row.model}`, row.model, row);
    const key = sourceKey(row.source, row.runtime);
    bump(groups.source, key, SOURCE_LABELS[key] ?? key, row);
  }

  // The same model through two providers keeps one row each: name the provider when labels collide.
  const modelLabels = new Map<string, number>();
  for (const entry of groups.model.values()) modelLabels.set(entry.label, (modelLabels.get(entry.label) ?? 0) + 1);
  for (const [key, entry] of groups.model) if ((modelLabels.get(entry.label) ?? 0) > 1) entry.label = `${entry.label} (${key.slice(0, key.indexOf('/'))})`;

  return {
    period,
    from,
    to,
    totals,
    peopleTotals,
    groups: {
      project: finish(groups.project, totals),
      goal: finish(groups.goal, totals),
      agent: finish(groups.agent, totals),
      person: finish(groups.person, peopleTotals),
      model: finish(groups.model, totals),
      source: finish(groups.source, totals),
    },
    caps: capsFor(actor, admin),
    requests: requestsFor(actor, admin, now),
    viewer: { admin, userId: actor.id },
    capRaise: capRaiseSetup(),
  };
}

/** `fn`'s first answer, kept for the rest of one pass. */
function once<T>(fn: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) {
      value = fn();
      done = true;
    }
    return value;
  };
}
