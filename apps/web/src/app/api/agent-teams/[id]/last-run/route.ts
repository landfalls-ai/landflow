import { agentTeamStore } from '@/lib/server/agent-teams/store';
import { error, handler, json } from '@/lib/server/http';
import { store } from '@/lib/server/store';
import { activityOfRuns } from '@/lib/shared/team-progress';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/**
 * GET — the team's latest run in a flow (a Run a Team node with this team): which execution, when, and each member's
 * tokens against its budget, so the team page draws its budget bars. `run` is absent when the team has not run yet.
 */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const team = agentTeamStore.get(id);
  if (!team) return error('Agent team not found', 404);
  const budgets = new Map((team.published ?? team.draft).members.map((m) => [m.title, m.budgetTokens] as const));
  for (const record of store.executionsMentioning(`"teamId":"${id}"`, 10)) {
    const node = record.workflow?.nodes.find((n) => n.type === 'core.runTeam' && n.parameters.teamId === id && record.runData[n.id]?.length);
    if (!node) continue;
    const runs = record.runData[node.id];
    const item = runs.at(-1)?.outputs?.flat().find((i) => i?.json && Array.isArray((i.json as { members?: unknown }).members))?.json as { members?: Array<{ title: string; tokens?: number; estimated?: boolean; overBudget?: boolean; costUsd?: number }> } | undefined;
    const activity = activityOfRuns(runs);
    const members = (item?.members ?? []).map((m) => ({
      title: m.title,
      tokens: m.tokens ?? 0,
      ...(budgets.get(m.title) ? { budgetTokens: budgets.get(m.title) } : {}),
      ...(m.estimated && { estimated: true }),
      ...(m.overBudget && { overBudget: true }),
      ...(m.costUsd !== undefined && { costUsd: m.costUsd }),
    }));
    return json({
      run: {
        executionId: record.executionId,
        workflowId: record.workflowId,
        workflowName: record.workflowName,
        status: record.status,
        startedAt: record.startedAt,
        nodeName: node.name,
        members,
        ...(activity && { durationMs: activity.durationMs, moments: activity.moments.filter((m) => m.tone !== 'info' || m.note).slice(-5) }),
      },
    });
  }
  return json({});
});
