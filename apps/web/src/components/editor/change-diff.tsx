'use client';
/**
 * What Apply would change, per step and value (docs/assistant.md#fold-apply-and-errors): the old value struck through
 * and the new one plain, a long text folded to two lines with "Show all", and how many steps stay as they are. Read from
 * the proposal's ops and the canvas they apply to (`diffOps`), not from the model's words.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { diffOps, type AssistantOp, type ChangeDiff as Diff, type FieldDiff, type StepDiff } from '@/lib/shared/assistant-ops';
import type { Workflow } from '@/lib/shared/types';
import { editorLookup } from './assistant';
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

/** One changed value: "label: old → new", a long one folded to two lines until "Show all". */
function FieldRow({ field }: { field: FieldDiff }) {
  const [all, setAll] = useState(false);
  const { before, after } = field;
  if (field.long && all) {
    return (
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-1.5 text-t2">
          <span className="font-semibold text-t1">{field.label}</span>
          <button type="button" aria-expanded onClick={() => setAll(false)} className="text-ac hover:underline max-md:min-h-11">
            Show less
          </button>
        </div>
        {before !== undefined && <Block label="Was" text={before} />}
        {after !== undefined && <Block label="Now" text={after} fresh />}
      </div>
    );
  }
  return (
    <div className="min-w-0 text-t2">
      <span className="font-semibold text-t1">{field.label}</span>: {before !== undefined && <span className={cn('text-t3 line-through decoration-t3/60', field.long && 'line-clamp-2 whitespace-pre-wrap')}>{before}</span>}
      {before !== undefined && after !== undefined && <span className="text-t3"> → </span>}
      {after !== undefined && <span className={cn('text-t1', field.long && 'line-clamp-2 whitespace-pre-wrap')}>{after}</span>}
      {field.long && (
        <button type="button" aria-expanded={false} onClick={() => setAll(true)} className="ml-1.5 text-ac hover:underline max-md:min-h-11">
          Show all
        </button>
      )}
    </div>
  );
}

function Block({ label, text, fresh }: { label: string; text: string; fresh?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-t3">{label}</div>
      <pre className={cn('max-h-[240px] overflow-auto whitespace-pre-wrap rounded-md border border-hair bg-wl px-1.5 py-1 font-mono text-[11px] leading-snug [overflow-wrap:anywhere]', fresh ? 'text-t1' : 'text-t3')}>{text}</pre>
    </div>
  );
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
          <FieldRow key={f.key} field={f} />
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
            Changes the agent{o.node ? ` of “${o.node}”` : ''}: <span className="text-t1">{o.change}</span>
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
                  <FieldRow key={f.key} field={f} />
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
