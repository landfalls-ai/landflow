/**
 * What a running node reports (`node.progress`, ctx.sendProgress) and how the execution view shows it: the remote
 * agent's steps as a RemoteRun (the shape the agent timeline renders), and a one-line caption for the canvas.
 */
import type { RemoteRun, RemoteToolStep } from '../shared/agents';
import { narrate, shortArg } from '../shared/team-progress';
import type { ExecutionEvent } from '../shared/types';

export { shortArg };

/** A node's latest report; `since` is when it first reported (from the server, or the first event this page saw). */
export type NodeProgress = Extract<ExecutionEvent, { type: 'node.progress' }> & { since?: string };

const STATUSES = new Set<RemoteToolStep['status']>(['running', 'success', 'error', 'awaiting_approval']);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Progress carries arguments as shortened JSON text; steps in a finished output carry objects. */
function argsOf(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : { value };
  } catch {
    return { value };
  }
}

/**
 * Steps from a progress report or a node's output (`steps`): the A2A node's `{ name, status, args, output }`, a
 * Run an Agent node's `{ tool, kind, status }`. Anything else is dropped.
 */
export function stepsOf(value: unknown): RemoteToolStep[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index): RemoteToolStep[] => {
    if (!isRecord(raw)) return [];
    const name = typeof raw.name === 'string' ? raw.name : typeof raw.tool === 'string' ? raw.tool : undefined;
    if (!name) return [];
    const status = STATUSES.has(raw.status as RemoteToolStep['status']) ? (raw.status as RemoteToolStep['status']) : 'success';
    const args = argsOf(raw.args);
    return [
      {
        id: typeof raw.id === 'string' ? raw.id : `${index}:${name}`,
        name,
        status,
        ...(args && { args }),
        ...(raw.output !== undefined && raw.output !== null && { output: raw.output }),
        ...(typeof raw.error === 'string' && raw.error && { error: raw.error }),
        ...(typeof raw.startedAt === 'string' && { startedAt: raw.startedAt }),
        ...(typeof raw.endedAt === 'string' && { endedAt: raw.endedAt }),
      },
    ];
  });
}

/** A progress report as the remote run the agent timeline renders. */
export function remoteRunOfProgress(event: Pick<NodeProgress, 'data' | 'nodeName'>): RemoteRun {
  const { data } = event;
  return {
    agent: typeof data.agent === 'string' ? data.agent : event.nodeName,
    state: typeof data.state === 'string' ? data.state : 'working',
    ...(typeof data.taskId === 'string' && { taskId: data.taskId }),
    ...(typeof data.contextId === 'string' && { contextId: data.contextId }),
    steps: stepsOf(data.steps),
  };
}

/** A result in one short line. */
export function snippetOf(value: unknown, max = 100): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * "Developer · Running the tests", or the state when no step runs yet: the step in plain words (lib/shared/team-progress.ts
 * `narrate`). A team node names the member working now and what it does (`member`, `plain`).
 */
export function progressLine(event: Pick<NodeProgress, 'data' | 'nodeName'>): string {
  const { data } = event;
  if (typeof data.member === 'string') return `${data.member} · ${typeof data.plain === 'string' ? data.plain : typeof data.doing === 'string' ? data.doing : 'working'}`;
  const run = remoteRunOfProgress(event);
  const step = [...run.steps].reverse().find((s) => s.status === 'running' || s.status === 'awaiting_approval') ?? run.steps.at(-1);
  return `${event.nodeName} · ${step ? narrate(step.name, step.args).plain : run.state}`;
}

/** The step's exact command or argument, for a tooltip beside the plain words. */
export function progressDetail(event: Pick<NodeProgress, 'data' | 'nodeName'>): string | undefined {
  const { data } = event;
  if (typeof data.member === 'string') return typeof data.command === 'string' ? data.command : typeof data.doing === 'string' ? data.doing : undefined;
  const run = remoteRunOfProgress(event);
  const step = [...run.steps].reverse().find((s) => s.status === 'running' || s.status === 'awaiting_approval') ?? run.steps.at(-1);
  const arg = step && shortArg(step.args, 200);
  return step ? `${step.name}${arg ? `: ${arg}` : ''}` : undefined;
}

/** Does a timeline tool call (label or tool name) stand for this sub-node? */
export function matchesNode(entry: { tool: string; label: string }, nodeName: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return norm(entry.label) === norm(nodeName) || norm(entry.tool) === norm(nodeName);
}
