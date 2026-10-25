'use client';
import { AlarmClock, Bug, MessageCircle, MousePointerClick, RadioTower, RotateCcw, Webhook, Wrench, type LucideIcon } from 'lucide-react';
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
};

export const RERUN_LABEL: Record<RerunScope, string> = { all: 'Re-run', from: 'Re-run from a node', only: 'Re-run of one node' };

export function rerunTitle(rerunOf: RerunOf, nodeName?: string) {
  return `${RERUN_LABEL[rerunOf.scope]}${nodeName ? ` “${nodeName}”` : ''} of ${rerunOf.executionId}`;
}

/** The small mode / re-run / debug icons on the right of an execution card or row. */
export function ExecutionMarks({ execution, className }: { execution: Pick<ExecutionSummary, 'mode' | 'rerunOf' | 'debug'>; className?: string }) {
  const mode = MODE_META[execution.mode] ?? MODE_META.manual;
  const ModeIcon = mode.icon;
  return (
    <span className={cn('flex shrink-0 items-center gap-1.5 text-t3', className)}>
      {execution.rerunOf && (
        <span title={rerunTitle(execution.rerunOf)} className="grid size-[18px] place-items-center rounded-full bg-[color-mix(in_oklab,var(--viz-1)_14%,transparent)] text-viz-1">
          <RotateCcw className="size-2.5" strokeWidth={2.5} />
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

/** Cancels a live run, or deletes a finished one from history. */
export function deleteExecution(executionId: string) {
  return api<{ canceled?: boolean; deleted?: boolean }>(`/api/executions/${executionId}`, { method: 'DELETE' });
}
