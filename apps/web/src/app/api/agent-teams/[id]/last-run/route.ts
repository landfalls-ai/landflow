import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler, json } from '@/lib/server/http';
import { liveExecution, liveExecutions, liveProgress } from '@/lib/server/runner';
import { store } from '@/lib/server/store';
import { activityOfRuns, type TeamProgress } from '@/lib/shared/team-progress';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

interface MemberUse {
  title: string;
  tokens: number;
  budgetTokens?: number;
  estimated?: boolean;
  overBudget?: boolean;
  costUsd?: number;
  /** Its manager never asked it in this run. */
  notAsked?: boolean;
  /** Working now (a live run only). */
  working?: boolean;
}

/**
 * GET — the team's latest run in a flow (a Run a Team node with this team): which execution, when, and each member's
 * tokens against its budget, so the team page draws its budget bars. A run going on now comes first, read from the
 * node's live progress (`live: true`; the page reads again every few seconds). Members with a budget that weren't asked
 * are listed with `notAsked`, so each budget shows. `run` is absent when the team has not run yet.
 */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const team = agentTeamStore.get(id);
  if (!team) return error('Agent team not found', 404);
  const members = (team.published ?? team.draft).members;
  const budgets = new Map(members.map((m) => [m.title, m.budgetTokens] as const));
  const withBudget = (m: MemberUse): MemberUse => ({ ...m, ...(budgets.get(m.title) ? { budgetTokens: budgets.get(m.title) } : {}) });
  // Every member with a budget shows, asked or not.
  const complete = (used: MemberUse[]): MemberUse[] => [
    ...used,
    ...members.filter((m) => m.budgetTokens && !used.some((u) => u.title === m.title)).map((m) => ({ title: m.title, tokens: 0, budgetTokens: m.budgetTokens, notAsked: true })),
  ];

  for (const summary of liveExecutions()) {
    const record = liveExecution(summary.id);
    const node = record?.workflow?.nodes.find((n) => n.type === 'core.runTeam' && n.parameters.teamId === id);
    const progress = node && (liveProgress(summary.id)[node.id]?.data as unknown as TeamProgress | undefined);
    if (!record || !node || !progress?.team) continue;
    const usage = new Map((progress.usage ?? []).map((u) => [u.member, u] as const));
    const used = progress.team.members.map((m): MemberUse => {
      const u = usage.get(m.title);
      return withBudget({
        title: m.title,
        tokens: u?.tokens ?? 0,
        ...(u?.estimated && { estimated: true }),
        ...(u?.budget && u.tokens >= u.budget && { overBudget: true }),
        ...(m.state === 'idle' && !m.asked && { notAsked: true }),
        // The member at work now, not its managers waiting on it (they are `working` too).
        ...(m.title === progress.member && { working: true }),
      });
    });
    return json({
      run: {
        executionId: record.executionId,
        workflowId: record.workflowId,
        workflowName: record.workflowName,
        status: record.status,
        startedAt: record.startedAt,
        nodeName: node.name,
        live: true,
        member: progress.member,
        members: complete(used),
        durationMs: progress.at,
        moments: progress.moments.filter((m) => m.tone !== 'info' || m.note).slice(-5),
      },
    });
  }

  for (const record of await store.executionsMentioningAsync(`"teamId":"${id}"`, 10)) {
    const node = record.workflow?.nodes.find((n) => n.type === 'core.runTeam' && n.parameters.teamId === id && record.runData[n.id]?.length);
    if (!node) continue;
    const runs = record.runData[node.id];
    const item = runs.at(-1)?.outputs?.flat().find((i) => i?.json && Array.isArray((i.json as { members?: unknown }).members))?.json as { members?: Array<{ title: string; asked?: number; tokens?: number; estimated?: boolean; overBudget?: boolean; costUsd?: number }> } | undefined;
    const activity = activityOfRuns(runs);
    const used = (item?.members ?? []).map((m) =>
      withBudget({
        title: m.title,
        tokens: m.tokens ?? 0,
        ...(m.estimated && { estimated: true }),
        ...(m.overBudget && { overBudget: true }),
        ...(m.costUsd !== undefined && { costUsd: m.costUsd }),
        ...(m.asked === 0 && !m.tokens && { notAsked: true }),
      }),
    );
    return json({
      run: {
        executionId: record.executionId,
        workflowId: record.workflowId,
        workflowName: record.workflowName,
        status: record.status,
        startedAt: record.startedAt,
        nodeName: node.name,
        members: complete(used),
        ...(activity && { durationMs: activity.durationMs, moments: activity.moments.filter((m) => m.tone !== 'info' || m.note).slice(-5) }),
      },
    });
  }
  return json({});
});
