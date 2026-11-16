/**
 * The AI page's report (docs/llm-gateway.md, "The AI page"): spend and tokens for a period by project, agent, person,
 * model and source, the caps and how near each is, the cap-raise requests and whether asking for more is on.
 *
 * Visibility: owners and admins see every row. Anyone else sees a row when they can read its workflow or agent, or it
 * is their own; a row they can't see is in no total and its project, goal, agent or workflow is "Another ...". The
 * person group is the exception (the user's decision D1, 2026-11-15): every member sees every person's spend by name,
 * from every row of the period, in `peopleTotals`. Other people's caps stay private (`capsFor`).
 */
import { watchedCaps } from '../ai-usage/alerts';
import { getUser } from '../auth/users';
import { aiSpendReport, type AiSpendQuery } from '../ai-usage/spend-report';
import { database } from '../db';
import { productionWorkflowById } from '../publish';
import { canResource, isInstanceAdmin, projectRole } from '../projects/access';
import type { Actor } from '../projects/access';
import {
  backstopBudget,
  parseCapId,
  type AiConsoleCap,
  type AiConsolePeriod,
  type CapRaiseRequest,
  type CapRaiseSetup,
  type CapRaiseStatus,
  type GatewayBudget,
} from '../../shared/llm-gateway';
import type { AiPageReport } from '../../shared/ai-spend';
import { gatewaySettings } from './settings';

const DAY_MS = 86_400_000;
/** SP08: the report's own rules (periods, groups, filters, visibility) live in ai-usage/spend-report.ts; `sourceKey` is kept here for its callers. */
export { sourceKey } from '../ai-usage/spend-report';

const userLabel = (id: string) => getUser(id)?.name || getUser(id)?.email || 'Someone';

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

/**
 * The AI page's report: `aiSpendReport`'s totals, groups, series, previous period and `peopleTotals` (SP08), with the
 * caps, requests, viewer and cap-raise set-up of this page, every key it had before keeping its meaning.
 * `query` is a period (`'24h'`, `'7d'`, `'30d'`) or a full query (90 days, a custom range, filters, `compare`, `stack`).
 */
export function aiConsoleReport(actor: Actor, query: AiConsolePeriod | AiSpendQuery, now = Date.now()): AiPageReport {
  const admin = isInstanceAdmin(actor);
  const report = aiSpendReport(actor, typeof query === 'string' ? { period: query } : query, now);
  return {
    ...report,
    caps: capsFor(actor, admin),
    requests: requestsFor(actor, admin, now),
    viewer: { admin, userId: actor.id },
    // SP08: the cap-raise set-up stays this report's, as the cap cards read it.
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
