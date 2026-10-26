'use client';
/**
 * Header chips of an execution: what its model calls used (tokens and estimated cost, per model on click —
 * lib/server/ai-usage) and, for a run started by a trigger's debounce or batching, how many held events it took.
 * Also the links between Execute Workflow parents and their sub-executions: "Sub-execution of …" on a child, and
 * "Waiting on N of M sub-workflows" with a link to each child on a parent that waits for them.
 */
import { Ban, Check, CornerLeftUp, Hourglass, Layers, Sparkles, X } from 'lucide-react';
import { waitedChildren } from '@/lib/client/run-data';
import { formatCost, formatTokens, type ExecutionAiUsage } from '@/lib/shared/ai-usage';
import type { ExecutionRecord } from '@/lib/shared/types';
import { Popover } from '../ui/popover';

/** "1,234 tokens · $0.0123"; a click lists the models. */
export function AiUsageChip({ usage }: { usage: ExecutionAiUsage | undefined }) {
  if (!usage || !usage.calls) return null;
  const tokens = usage.inputTokens + usage.outputTokens;
  return (
    <Popover
      align="start"
      className="w-[340px] p-3"
      trigger={({ open, toggle }) => (
        <button
          onClick={toggle}
          aria-expanded={open}
          title="AI usage of this execution (estimated cost from the price table in Settings)"
          className="flex items-center gap-1 rounded-full bg-[color-mix(in_oklab,var(--viz-5)_14%,transparent)] px-2 text-[12px] tabular-nums text-viz-5 transition-opacity hover:opacity-80"
        >
          <Sparkles className="size-3" /> {formatTokens(tokens)} tokens · {formatCost(usage.cost)}
        </button>
      )}
    >
      <div className="space-y-2 text-[12px]">
        <div className="text-[13px] font-semibold text-t1">AI usage</div>
        <div className="grid grid-cols-4 gap-2 tabular-nums">
          {[
            ['Input', formatTokens(usage.inputTokens)],
            ['Output', formatTokens(usage.outputTokens)],
            ['Calls', String(usage.calls)],
            ['Cost', formatCost(usage.cost)],
          ].map(([label, value]) => (
            <div key={label} className="rounded-[8px] border border-hair bg-wl px-2 py-1.5">
              <div className="text-[10px] uppercase tracking-wide text-t3">{label}</div>
              <div className="font-semibold text-t1">{value}</div>
            </div>
          ))}
        </div>
        {usage.models.length > 0 && (
          <table className="w-full tabular-nums">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wide text-t3">
                <th className="py-1 font-medium">Model</th>
                <th className="py-1 text-right font-medium">In</th>
                <th className="py-1 text-right font-medium">Out</th>
                <th className="py-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.models.map((m) => (
                <tr key={`${m.provider}/${m.model}`} className="border-t border-hair text-t2">
                  <td className="max-w-[150px] truncate py-1" title={`${m.provider}/${m.model} · ${m.calls} call${m.calls === 1 ? '' : 's'}`}>
                    <span className="text-t3">{m.provider}/</span>
                    {m.model}
                  </td>
                  <td className="py-1 text-right">{formatTokens(m.inputTokens)}</td>
                  <td className="py-1 text-right">{formatTokens(m.outputTokens)}</td>
                  <td className="py-1 text-right">{formatCost(m.cost)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="leading-snug text-t3">This execution’s own calls; sub-workflows list theirs. Costs are estimates from Settings → AI prices.</p>
      </div>
    </Popover>
  );
}

/** "Debounced: 3 events" / "Batch of 5 events". */
export function BufferedChip({ buffered }: { buffered: ExecutionRecord['buffered'] }) {
  if (!buffered) return null;
  const events = `${buffered.count} event${buffered.count === 1 ? '' : 's'}`;
  return (
    <span
      className="flex items-center gap-1 rounded-full border border-hair px-2 text-[12px] text-t2"
      title={buffered.kind === 'debounce' ? 'Started by the trigger’s debounce: events that came in close together, one run' : 'Started by the trigger’s batching: one run for the collected events'}
    >
      <Layers className="size-3" /> {buffered.kind === 'debounce' ? `Debounced: ${events}` : `Batch of ${events}`}
    </span>
  );
}

// The waited children are read from `wait.data` by lib/client/run-data (the canvas's waiting mark uses them too).
export { waitedChildren };

/** "Sub-execution of ex_…": back to the execution whose Execute Workflow node started this one. */
export function ParentChip({ parentId, onOpen }: { parentId: string | undefined; onOpen: (executionId: string) => void }) {
  if (!parentId) return null;
  return (
    <button
      onClick={() => onOpen(parentId)}
      title="Open the execution whose Execute Workflow node started this one"
      className="flex items-center gap-1 rounded-full border border-hair px-2 text-[12px] text-t2 transition-colors hover:text-t1"
    >
      <CornerLeftUp className="size-3" /> Sub-execution of <span className="font-mono">{parentId}</span>
    </button>
  );
}

const CHILD_STATE = {
  success: { icon: Check, label: 'finished', className: 'text-gn' },
  error: { icon: X, label: 'failed', className: 'text-rd' },
  canceled: { icon: Ban, label: 'canceled', className: 'text-t3' },
  waiting: { icon: Hourglass, label: 'waiting', className: 'text-viz-1' },
} as const;

/** A parent waiting for its sub-workflows: "Waiting on 2 of 3 sub-workflows", and a link to each child. */
export function SubWorkflowWait({ record, onOpen }: { record: ExecutionRecord; onOpen: (executionId: string) => void }) {
  const children = waitedChildren(record);
  if (!children?.length) return null;
  const open = children.filter((child) => !child.status).length;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl border border-hair bg-[color-mix(in_oklab,var(--viz-1)_8%,transparent)] px-3 py-2 text-[13px] text-t2 animate-fade-up">
      <Hourglass className="size-3.5 shrink-0 text-viz-1" />
      <span>
        Waiting on <b className="font-semibold tabular-nums text-t1">{open} of {children.length}</b> sub-workflow{children.length === 1 ? '' : 's'}
        {record.wait?.nodeName && <> at “{record.wait.nodeName}”</>}; it goes on when {children.length === 1 ? 'it finishes' : 'the last one finishes'}.
      </span>
      {children.map((child) => {
        const state = CHILD_STATE[child.status ?? 'waiting'];
        const Icon = state.icon;
        return (
          <button
            key={child.executionId}
            onClick={() => onOpen(child.executionId)}
            title={`Item ${child.item + 1}: ${state.label} · open the sub-execution`}
            className="flex items-center gap-1 rounded-full border border-hair bg-sf px-2 text-[12px] text-t2 transition-colors hover:text-t1"
          >
            <Icon className={`size-3 ${state.className}`} />
            {children.length > 1 && <span className="tabular-nums text-t3">#{child.item + 1}</span>}
            <span className="font-mono">{child.executionId}</span>
          </button>
        );
      })}
    </div>
  );
}
