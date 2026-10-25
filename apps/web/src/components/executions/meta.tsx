'use client';
import { AlarmClock, Bug, FlaskConical, MessageCircle, MousePointerClick, Plug, Power, RadioTower, Redo2, Repeat, RotateCcw, Webhook, Wrench, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import type { ExecutionSummary, RerunOf, RerunScope } from '@/lib/shared/types';

export const MODE_META: Record<ExecutionSummary['mode'], { label: string; icon: LucideIcon }> = {
  manual: { label: 'Started manually', icon: MousePointerClick },
  webhook: { label: 'Started by a webhook', icon: Webhook },
  chat: { label: 'Started from chat', icon: MessageCircle },
  trigger: { label: 'Started by a schedule', icon: AlarmClock },
  tool: { label: 'Called as a tool', icon: Wrench },
  poll: { label: 'Started by a polling trigger', icon: RadioTower },
  mcp: { label: 'Started by an MCP client', icon: Plug },
};

export const RERUN_LABEL: Record<RerunScope, string> = { all: 'Re-run', from: 'Re-run from a node', only: 'Re-run of one node' };

export function rerunTitle(rerunOf: RerunOf, nodeName?: string) {
  return `${RERUN_LABEL[rerunOf.scope]}${nodeName ? ` “${nodeName}”` : ''} of ${rerunOf.executionId}`;
}

/** "Retry #2 of 1a2b…" */
export function retryTitle(execution: Pick<ExecutionSummary, 'retryOf' | 'retryAttempt'>) {
  return `Retry #${execution.retryAttempt ?? 1} of ${execution.retryOf}`;
}

type MarkedExecution = Pick<ExecutionSummary, 'mode' | 'rerunOf' | 'debug' | 'retryOf' | 'retryAttempt' | 'retriedBy' | 'resumedAfterRestart'> & Partial<Pick<ExecutionSummary, 'evaluation'>>;

/** The small mode / re-run / retry / debug icons on the right of an execution card or row. */
export function ExecutionMarks({ execution, className }: { execution: MarkedExecution; className?: string }) {
  const mode = MODE_META[execution.mode] ?? MODE_META.manual;
  const ModeIcon = mode.icon;
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-t3', className)}>
      {execution.resumedAfterRestart && (
        <span title="Resumed after restart" className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_oklab,var(--viz-4)_14%,transparent)] text-viz-4">
          <Power className="size-2.5" strokeWidth={2.5} />
        </span>
      )}
      {execution.retryOf && (
        <span title={retryTitle(execution)} className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_oklab,var(--viz-7)_14%,transparent)] text-viz-7">
          <Repeat className="size-2.5" strokeWidth={2.5} />
        </span>
      )}
      {execution.retriedBy && (
        <span title={`Retried by ${execution.retriedBy}`} className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_oklab,var(--viz-7)_14%,transparent)] text-viz-7">
          <Redo2 className="size-2.5" strokeWidth={2.5} />
        </span>
      )}
      {execution.rerunOf && (
        <span title={rerunTitle(execution.rerunOf)} className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_oklab,var(--viz-1)_14%,transparent)] text-viz-1">
          <RotateCcw className="size-2.5" strokeWidth={2.5} />
        </span>
      )}
      {execution.evaluation && (
        <span title="Test case of an evaluation run" className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_oklab,var(--viz-5)_14%,transparent)] text-viz-5">
          <FlaskConical className="size-2.5" strokeWidth={2.5} />
        </span>
      )}
      {execution.debug && (
        <span title="Debug run" className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_oklab,var(--viz-2)_14%,transparent)] text-viz-2">
          <Bug className="size-2.5" strokeWidth={2.5} />
        </span>
      )}
      <span title={mode.label}>
        <ModeIcon className="size-3.5" strokeWidth={1.8} />
      </span>
    </span>
  );
}

export interface RerunBody {
  scope: RerunScope;
  nodeId?: string;
  version?: 'current' | 'original';
}

/** Start a re-run in the background; resolves with the new execution id. */
export async function startRerun(executionId: string, body: RerunBody): Promise<string> {
  const { executionId: id } = await api<{ executionId: string }>(`/api/executions/${executionId}/rerun`, { method: 'POST', json: body });
  return id;
}

export interface RetryBody {
  /** `failed` (default): continue from the failed node, reusing what ran before it; `start`: run it all again with the same input. */
  from?: 'failed' | 'start';
  /** `original` (default): the version the execution ran. */
  version?: 'current' | 'original';
}

/** Retry a failed or canceled execution (linked through `retryOf` / `retriedBy`); resolves with the new execution id. */
export async function startRetry(executionId: string, body: RetryBody = {}): Promise<string> {
  const { executionId: id } = await api<{ executionId: string }>(`/api/executions/${executionId}/retry`, { method: 'POST', json: body });
  return id;
}

/** Only failed and canceled executions can be retried. */
export function canRetry(execution: Pick<ExecutionSummary, 'status'>) {
  return execution.status === 'error' || execution.status === 'canceled';
}

/** Cancels a live (running, waiting or queued) run, or deletes a finished one from history. */
export function deleteExecution(executionId: string) {
  return api<{ canceled?: boolean; deleted?: boolean }>(`/api/executions/${executionId}`, { method: 'DELETE' });
}

export interface StopAllResult {
  running: number;
  waiting: number;
  queued: number;
  retries: number;
}

/** Abort every running execution, cancel waiting and queued ones and drop pending automatic retries. */
export function stopAllExecutions() {
  return api<StopAllResult>('/api/executions/stop-all', { method: 'POST' });
}

/** "Stopped 2 running and 1 queued executions, dropped 1 automatic retry" (or `undefined` when nothing was stopped). */
export function stopAllSummary(result: StopAllResult): string | undefined {
  const parts = (
    [
      [result.running, 'running'],
      [result.waiting, 'waiting'],
      [result.queued, 'queued'],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, what]) => `${n} ${what}`);
  const total = result.running + result.waiting + result.queued;
  const stopped = total ? `Stopped ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]} execution${total === 1 ? '' : 's'}` : '';
  const retries = result.retries ? `${stopped ? 'dropped' : 'Dropped'} ${result.retries} automatic retr${result.retries === 1 ? 'y' : 'ies'}` : '';
  return [stopped, retries].filter(Boolean).join(', ') || undefined;
}
