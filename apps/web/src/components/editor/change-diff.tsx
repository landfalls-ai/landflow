'use client';
/**
 * What Apply would change, per step and value (docs/assistant.md#fold-apply-and-errors): the old value struck through
 * and the new one plain, a long text folded to two lines with "Show all", and how many steps stay as they are. Read from
 * the proposal's ops and the canvas they apply to (`diffOps`), not from the model's words. Each value's line is the kit's
 * `FieldRow` (components/ui/field-diff.tsx).
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { diffOps, type AssistantOp, type ChangeDiff as Diff, type StepDiff } from '@/lib/shared/assistant-ops';
import type { Workflow } from '@/lib/shared/types';
import { FieldRow } from '../ui/field-diff';
import { editorLookup } from './assistant';
import { useBubbleData } from '@/lib/client/agent-bubble-data';
import { useEditor } from './store';

const SIGN: Record<StepDiff['kind'], { sign: string; tone: string }> = {
  added: { sign: '+', tone: 'text-gn' },
  changed: { sign: '~', tone: 'text-warn' },
  removed: { sign: '−', tone: 'text-rd' },
  renamed: { sign: '✎', tone: 'text-ac' },
};

/** The diff a card showed while its change waited, by proposal id: once applied the canvas already holds the change. */
const shown = new Map<string, Diff>();
export const hasDiff = (id: string) => shown.has(id);

/** The canvas as a workflow, re-read when a node or a connection changes. */
export function useCanvas(): Workflow {
  const nodes = useEditor((s) => s.nodes);
  const edges = useEditor((s) => s.edges);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- toWorkflow reads the nodes and edges
  return useMemo(() => useEditor.getState().toWorkflow(), [nodes, edges]);
}

function StepBlock({ step }: { step: StepDiff }) {
  const { sign, tone } = SIGN[step.kind];
  return (
    <div className="flex gap-1.5">
      <span className={cn('w-3 shrink-0 text-center font-semibold', tone)}>{sign}</span>
      <div className="min-w-0 flex-1 space-y-0.5 [overflow-wrap:anywhere]">
        <div className="text-t1">
          {step.kind === 'renamed' ? (
            <>
              “{step.was}” → “{step.node}”
            </>
          ) : (
            <>“{step.node}”</>
          )}
          {step.kind === 'added' && <span className="text-t3"> new step</span>}
          {step.kind === 'removed' && <span className="text-t3"> removed</span>}
        </div>
        {step.fields.map((f) => (
          <FieldRow key={f.key} label={f.label} before={f.before} after={f.after} long={f.long} />
        ))}
        {step.wires.map((w) => (
          <div key={w} className="text-t2">
            {w}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The change as a block: a header (how many steps, with a toggle), one block per touched step, and the count of steps it
 * leaves as they are. `open` is whether it starts open (a waiting card) or folded (an applied row). With `id` (the
 * proposal) and `settled` (it is applied), the diff the card showed while it waited is shown, since the canvas has it now.
 */
/** Whose agent a changeAgent changes: the step it names, else the step on the canvas that runs the agent, else the agent's own name. */
function agentOwner(op: { node?: string; agentId?: string }, before?: Workflow): string | undefined {
  if (op.node) return op.node;
  if (!op.agentId) return undefined;
  const step = before?.nodes.find((n) => n.parameters?.agentId === op.agentId)?.name ?? useEditor.getState().nodes.find((n) => n.data.wf.parameters?.agentId === op.agentId)?.data.wf.name;
  if (step) return step;
  const known = Object.entries(useBubbleData.getState().answers).find(([k, a]) => a && k.startsWith(`${op.agentId}|`))?.[1];
  return known?.agent.name;
}

export function ChangeDiff({ before, ops, open = true, id, settled }: { before?: Workflow; ops: AssistantOp[] | AssistantOp[][]; open?: boolean; id?: string | string[]; settled?: boolean }) {
  const [on, setOn] = useState(open);
  const ids = id === undefined ? [] : Array.isArray(id) ? id : [id];
  const computed = useMemo(() => (settled || !before ? undefined : diffOps(before, ops, editorLookup())), [settled, before, ops]);
  const diff: Diff | undefined = settled ? shown.get(ids[0]) : computed;
  // Remembered once the card shows it (not in render): the canvas holds the change after Apply.
  useEffect(() => {
    if (computed) for (const i of ids) shown.set(i, computed);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computed, ids.join('|')]);
  if (!diff) return null;
  const { steps, untouched, workflow } = diff;
  const count = steps.length + (workflow?.length ? 1 : 0);
  // A changeAgent changes the agent, never the graph: the card says so instead of "No step changes" (Apply opens the agent's change card).
  const agentOps = (ops as AssistantOp[] | AssistantOp[][]).flat().filter((o): o is Extract<AssistantOp, { op: 'changeAgent' }> => o.op === 'changeAgent');
  if (count === 0 && agentOps.length) {
    return (
      <div data-testid="agent-change-line" className="rounded-lg border border-hair bg-sf px-2 py-1.5 text-[12px] leading-snug text-t2">
        {agentOps.map((o, i) => (
          <div key={i}>
            Changes the agent{agentOwner(o, before) ? ` of “${agentOwner(o, before)}”` : ''}: <span className="text-t1">{o.change}</span>
          </div>
        ))}
        <div className="text-t3">The steps stay as they are; Apply shows the agent’s change card.</div>
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-hair bg-sf px-2 py-1.5 font-mono text-[11px] leading-snug">
      <button type="button" aria-expanded={on} onClick={() => setOn((o) => !o)} className="flex w-full items-center gap-1 text-left text-t2 max-md:min-h-11">
        <ChevronRight className={cn('size-3 shrink-0 text-t3 transition-transform motion-reduce:transition-none', on && 'rotate-90')} />
        <span className="font-semibold text-t1">{count === 0 ? 'No step changes' : `${count} ${count === 1 ? 'change' : 'changes'}`}</span>
        {!on && <span className="text-t3">· {untouched === 0 ? 'no other step changes' : `${untouched} other step${untouched === 1 ? '' : 's'} untouched`}</span>}
      </button>
      {on && (
        <div className="mt-1 space-y-1.5">
          {steps.map((s) => (
            <StepBlock key={`${s.kind}:${s.was ?? s.node}`} step={s} />
          ))}
          {workflow?.length ? (
            <div className="flex gap-1.5">
              <span className="w-3 shrink-0 text-center font-semibold text-warn">~</span>
              <div className="min-w-0 flex-1 space-y-0.5 [overflow-wrap:anywhere]">
                <div className="text-t1">Workflow settings</div>
                {workflow.map((f) => (
                  <FieldRow key={f.key} label={f.label} before={f.before} after={f.after} long={f.long} />
                ))}
              </div>
            </div>
          ) : null}
          <div className="text-t3">{untouched === 0 ? 'No other step changes' : `${untouched} other step${untouched === 1 ? '' : 's'} untouched`}</div>
        </div>
      )}
    </div>
  );
}
