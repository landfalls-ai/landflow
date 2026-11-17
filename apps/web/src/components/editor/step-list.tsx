'use client';
/**
 * The phone's Steps view (docs/mobile.md#the-steps-view): the flow as cards in the order it runs (step-order.ts), each
 * with how its last run went. A tap opens the step full screen; **Add a step** goes on from the last one. The canvas
 * stays mounted under it, so Steps | Canvas switches without losing the view.
 */
import { useEffect, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { CircleAlert, CircleCheck, CircleDot, Loader2, Pause, Pin, Plus, PowerOff, CornerDownRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { duration } from '@/lib/client/format';
import { NodeIcon } from '../ui/icon';
import { useEditor } from './store';
import { stepOrder } from './step-order';

export function StepList() {
  // Only what the order depends on, so a run's progress doesn't recompute it. Node types count too: they name outputs.
  const shape = useEditor((s) =>
    [
      s.nodes.map((n) => `${n.id}:${n.data.wf.type}@${Math.round(n.position.x)},${Math.round(n.position.y)}`).join(';'),
      s.edges.map((e) => `${e.source}>${e.target}:${e.sourceHandle ?? ''}:${e.data?.connectionType ?? 'main'}`).join(';'),
    ].join('|'),
  );
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const { steps, anchor } = useMemo(() => {
    const { nodes, edges } = useEditor.getState();
    const outputsOf = (id: string) => {
      const type = nodes.find((n) => n.id === id)?.data.wf.type;
      return (type ? nodeTypes[type]?.descriptor.outputs.filter((p) => p.type === 'main') : undefined) ?? [];
    };
    const steps = stepOrder(
      nodes,
      edges.map((e) => ({ source: e.source, target: e.target, sourceHandle: e.sourceHandle, connectionType: e.data?.connectionType ?? 'main' })),
      { output: (id, i) => outputsOf(id)[i]?.displayName ?? `Output ${i + 1}`, outputs: (id) => outputsOf(id).length },
    );
    // Add a step goes on from the last step with a main output nothing is connected to yet.
    let anchor: { nodeId: string; handleId: string } | undefined;
    for (const step of [...steps].reverse()) {
      const used = new Set(edges.filter((e) => e.source === step.id && (e.data?.connectionType ?? 'main') === 'main').map((e) => e.sourceHandle ?? 'main:0'));
      const free = outputsOf(step.id).findIndex((_p, i) => !used.has(`main:${i}`));
      if (free >= 0 && used.size === 0) {
        anchor = { nodeId: step.id, handleId: `main:${free}` };
        break;
      }
    }
    return { steps, anchor };
    // `shape` stands for nodes and edges.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, nodeTypes]);

  // The canvas under the list is out of reach while the list shows: no focus, not read out.
  useEffect(() => {
    const canvas = document.querySelector('.react-flow');
    canvas?.setAttribute('inert', '');
    return () => canvas?.removeAttribute('inert');
  }, []);

  return (
    <div className="absolute inset-0 z-10 overflow-y-auto bg-bg px-3 pt-14 pb-28">
      <RunStatus ids={steps.map((step) => step.id)} />
      <ol aria-label="Steps" className="flex flex-col gap-2">
        {steps.map((step, i) => (
          <li key={step.id} style={{ marginLeft: Math.min(step.depth, 4) * 14 }}>
            {step.branch && (
              <div className="mb-1 mt-1 flex items-center gap-1 text-[12px] font-semibold text-t3">
                <CornerDownRight className="size-3.5" /> {step.branch}
              </div>
            )}
            <StepCard id={step.id} index={i + 1} attached={step.attached} then={step.then} />
          </li>
        ))}
      </ol>
      {anchor && (
        <button
          type="button"
          onClick={() => useEditor.getState().openPalette({ from: { ...anchor, handleType: 'source' } })}
          className="mt-3 flex h-12 w-full items-center justify-center gap-2 rounded-2xl border border-dashed border-bd text-[14px] font-semibold text-t2"
        >
          <Plus className="size-4" /> Add a step
        </button>
      )}
    </div>
  );
}

/** One line read out as a run moves through the steps (the cards change silently): what runs, what failed, or that all ran. */
function RunStatus({ ids }: { ids: string[] }) {
  const line = useEditor((s) => {
    const at = (state: string) => ids.findIndex((id) => s.statuses[id]?.state === state);
    const name = (i: number) => s.nodes.find((n) => n.id === ids[i])?.data.wf.name ?? '';
    const failed = at('error');
    if (failed >= 0) return `Step ${failed + 1}, “${name(failed)}”, failed: ${s.statuses[ids[failed]]?.error ?? ''}`;
    const running = at('running');
    if (running >= 0) return `Running step ${running + 1}, “${name(running)}”`;
    const ran = ids.filter((id) => s.statuses[id]?.state === 'success').length;
    return ran ? `${ran} of ${ids.length} steps ran` : '';
  });
  return (
    <p role="status" className="sr-only">
      {line}
    </p>
  );
}

function StepCard({ id, index, attached, then }: { id: string; index: number; attached: string[]; then: string[] }) {
  const wf = useEditor((s) => s.nodes.find((n) => n.id === id)?.data.wf);
  const info = useEditor((s) => (wf ? s.nodeTypes[wf.type] : undefined));
  const status = useEditor((s) => s.statuses[id]);
  const pinned = useEditor((s) => Boolean(s.pinData[id]));
  const breakpoint = useEditor((s) => s.breakpoints.includes(id));
  const names = useEditor(useShallow((s) => [...attached, ...then].map((other) => s.nodes.find((n) => n.id === other)?.data.wf.name ?? other)));
  if (!wf) return null;
  const open = (nodeId: string) => useEditor.getState().openNode(nodeId);
  const state = status?.state ?? 'idle';
  const items = status?.itemCounts?.reduce((a, b) => a + b, 0);
  const tone = state === 'error' ? 'border-rdbd' : state === 'success' ? 'border-gnbd' : state === 'running' || state === 'waiting' || state === 'paused' ? 'border-acbd' : 'border-hair';
  return (
    <div className={cn('rounded-2xl border bg-sf', tone, wf.disabled && 'border-dashed')}>
      <button type="button" onClick={() => open(id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-hair bg-wl">
          <NodeIcon icon={info?.descriptor.icon} size={18} className="text-t1" strokeWidth={1.6} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="text-[12px] tabular-nums text-t3">{index}</span>
            <span className="truncate text-[15px] font-semibold text-t1">{wf.name}</span>
            {wf.disabled && <PowerOff className="size-3.5 shrink-0 text-t3" aria-label="Off" />}
            {pinned && <Pin className="size-3.5 shrink-0 text-viz-7" aria-label="Pinned output" />}
            {breakpoint && <CircleDot className="size-3.5 shrink-0 text-rd" aria-label="Breakpoint" />}
          </span>
          <span className="block truncate text-[12.5px] text-t3">{info?.descriptor.displayName ?? wf.type}</span>
        </span>
        <StepState state={state} items={items} ms={status?.durationMs} />
      </button>
      {state === 'error' && status?.error && <p className="line-clamp-2 px-3 pb-2.5 text-[12.5px] text-rd">{status.error}</p>}
      {state === 'waiting' && status?.wait && <p className="px-3 pb-2.5 text-[12.5px] text-ac">{status.wait}</p>}
      {(attached.length > 0 || then.length > 0) && (
        <div className="flex flex-wrap gap-1.5 border-t border-hair px-3 py-2">
          {attached.map((sub, i) => (
            <button key={sub} type="button" onClick={() => open(sub)} className="h-11 rounded-full border border-hair bg-wl px-3.5 text-[13px] text-t2">
              {names[i]}
            </button>
          ))}
          {then.map((next, i) => (
            <button key={next} type="button" onClick={() => open(next)} className="flex h-11 items-center gap-1 rounded-full px-2 text-[13px] text-t3">
              <CornerDownRight className="size-3.5" /> then “{names[attached.length + i]}”
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function StepState({ state, items, ms }: { state: string; items?: number; ms?: number }) {
  if (state === 'running') return <Loader2 className="size-5 shrink-0 animate-spin text-ac" aria-label="Running" />;
  if (state === 'paused' || state === 'waiting') return <Pause className="size-5 shrink-0 text-ac" aria-label={state === 'paused' ? 'Paused' : 'Waiting'} />;
  if (state === 'idle') return null;
  return (
    <span className="flex shrink-0 flex-col items-end gap-0.5 text-[11.5px] tabular-nums text-t3">
      {state === 'error' ? <CircleAlert className="size-5 text-rd" aria-label="Failed" /> : <CircleCheck className="size-5 text-gn" aria-label="Succeeded" />}
      {state === 'success' && (
        <span>
          {items ?? 0} {items === 1 ? 'item' : 'items'}
          {ms !== undefined && ` · ${duration(ms)}`}
        </span>
      )}
    </span>
  );
}
