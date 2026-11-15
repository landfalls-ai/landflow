/**
 * Which project and goal a run is in, and how to say what the run is (docs/agents.md#which-project-a-run-is-in). The
 * caller's project comes first, so an agent used in several projects works for the one that called it; the agent's own
 * home is the last resort.
 */
import type { AgentSession } from '../../shared/agents';
import type { RunCaller, RunContextRef } from '../../shared/project-context';
import { agentTeamStore } from '../agent-teams/store';
import { homeProjectId } from '../projects/store';
import { store } from '../store';
import { contextDataSource } from './seam';

/** A workflow id that names a real, stored workflow (not an agent's `agent:<id>` pseudo-id, not `unknown`). */
const realWorkflow = (id: string | undefined): id is string => Boolean(id) && id !== 'unknown' && !id!.startsWith('agent:');

/** A goal that exists and is not cancelled. */
function liveGoal(goalId: string | undefined): string | undefined {
  if (!goalId) return undefined;
  const goal = contextDataSource()?.goalChain(goalId).at(-1);
  return goal && goal.status !== 'cancelled' ? goal.id : undefined;
}

/** The first planned or active goal a project serves. */
function primaryGoal(projectId: string | undefined): string | undefined {
  if (!projectId) return undefined;
  const source = contextDataSource();
  for (const id of source?.project(projectId)?.goalIds ?? []) {
    const goal = source?.goalChain(id).at(-1);
    if (goal && (goal.status === 'planned' || goal.status === 'active')) return goal.id;
  }
  return undefined;
}

export function resolveRun(ref: RunContextRef): { projectId?: string; goalId?: string } {
  const team = ref.teamId ? agentTeamStore.get(ref.teamId) : undefined;
  const workflow = realWorkflow(ref.workflowId) ? store.getWorkflow(ref.workflowId) : undefined;
  const projectId =
    ref.projectId ??
    (realWorkflow(ref.workflowId) ? homeProjectId('workflow', ref.workflowId) : undefined) ??
    team?.projectId ??
    (ref.agentId ? homeProjectId('agent', ref.agentId) : undefined);
  const teamGoal = (team?.published ?? team?.draft)?.goalId;
  const goalId = liveGoal(ref.goalId) ?? liveGoal(teamGoal) ?? liveGoal(workflow?.settings?.goalId) ?? primaryGoal(projectId);
  return { ...(projectId && { projectId }), ...(goalId && { goalId }) };
}

/** What a session's own fields say about who runs it; `agentId` is always set. */
export function refFromSession(session: AgentSession, agentId: string): RunContextRef {
  const teamId = session.userId.startsWith('team:') ? session.userId.slice('team:'.length) : undefined;
  const ex = session.execution;
  let caller: RunCaller;
  if (teamId) caller = 'team';
  else if (ex) caller = 'workflow';
  else
    caller =
      session.source === 'schedule'
        ? 'schedule'
        : session.source === 'telegram' || session.source === 'slack' || session.source === 'teams'
          ? 'channel'
          : session.source === 'agent'
            ? 'agent'
            : session.source === 'api'
              ? 'mcp'
              : session.source === 'workflow'
                ? 'workflow'
                : 'chat';
  return {
    caller,
    agentId,
    ...(teamId && { teamId }),
    ...(ex && { workflowId: ex.workflowId, executionId: ex.executionId, ...(ex.nodeName && { nodeName: ex.nodeName }) }),
  };
}

const q = (text: string) => `“${text}”`;

/** The "This run" line: what is happening, in words. */
export function runLine(ref: RunContextRef): string {
  const team = () => {
    const t = ref.teamId ? agentTeamStore.get(ref.teamId) : undefined;
    return t ? (t.published ?? t.draft).name || t.draft.name : undefined;
  };
  switch (ref.caller) {
    case 'workflow':
    case 'team': {
      const parts: string[] = [];
      if (realWorkflow(ref.workflowId)) {
        const name = store.getWorkflow(ref.workflowId)?.name;
        parts.push(`workflow ${q(name || ref.workflowId)}`);
        if (ref.nodeName) parts.push(`step ${q(ref.nodeName)}`);
      }
      const teamName = ref.teamId ? (team() ?? ref.teamId) : undefined;
      if (teamName) parts.push(`team ${q(teamName)}`);
      return parts.join(' → ') || (ref.caller === 'team' ? 'a team run' : 'a workflow run');
    }
    case 'chat':
      return 'a test chat';
    case 'schedule':
      return 'a scheduled run';
    case 'channel':
      return 'a message from a chat channel';
    case 'agent':
      return 'a task from another agent';
    case 'mcp':
      return 'a request over MCP';
    case 'assistant':
      return 'Spotlight';
    case 'task':
      return `project task ${q(ref.nodeName ?? 'untitled')}`;
  }
}
