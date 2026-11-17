'use client';
/**
 * The plan card (docs/assistant.md "Building a flow in stages"): the first draft's steps in words, one node each, before
 * anything is built. In asks-first it waits for Build it; the person can remove a step, choose another node for one, or
 * say what to change. While the flow builds it folds to one line and the canvas stays visible.
 */
import { useState } from 'react';
import { Check, ChevronRight, Loader2, X } from 'lucide-react';
import { api } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import type { BuildPlan } from '@/lib/shared/build-plan';
import { Button } from '../../ui/button';
import { NodeIcon } from '../../ui/icon';
import { Collapsible } from '../../ui/chat-motion';
import { useAssistant } from '../assistant';
import { pickedModel } from '../spotlight-model';
import { useEditor } from '../store';
import { buildIt, dropStep, stepCount, swapStep, type PlanPart } from './plan-part';

/** Change the plan card's part in the store. */
function edit(itemId: string, change: (part: PlanPart) => PlanPart) {
  useAssistant.getState().updateParts(itemId, (parts) => parts.map((p) => (p.kind === 'plan' ? { ...p, plan: change(p.plan) } : p)));
}

export function PlanCard({ itemId, part }: { itemId: string; part: PlanPart }) {
  const nodeTypes = useEditor((s) => s.nodeTypes);
  const [change, setChange] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [open, setOpen] = useState(false);
  const { plan, alternatives, state } = part;
  const waiting = state === 'waiting';
  const label = (type: string) => nodeTypes[type]?.descriptor.displayName ?? type;

  const send = async () => {
    const text = change.trim();
    if (!text || busy) return;
    setBusy(true);
    setProblem(undefined);
    try {
      const answer = await api<{ plan: BuildPlan; alternatives: PlanPart['alternatives'] }>('/api/ai/build/plan', {
        method: 'POST',
        json: { prompt: part.prompt, plan, change: text, workflowId: useEditor.getState().workflowId || undefined, ...pickedModel() },
      });
      edit(itemId, (p) => ({ ...p, plan: answer.plan, alternatives: answer.alternatives }));
      setChange('');
    } catch (e) {
      setProblem((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Building or built: one line (the canvas is where the work shows). A built plan opens to read.
  if (!waiting) {
    const working = state === 'building';
    return (
      <div className="animate-fade-up rounded-xl border border-hair bg-sf p-2.5" data-plan-state={state}>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={working} className="flex min-h-7 w-full items-center gap-1.5 text-left text-[12.5px] font-semibold text-t1 max-md:min-h-11">
          {working ? <Loader2 className="size-3.5 shrink-0 animate-spin text-ac" /> : state === 'built' ? <Check className="size-3.5 shrink-0 text-gn" /> : <X className="size-3.5 shrink-0 text-t3" />}
          <span className="min-w-0 flex-1">{working ? `Building ${stepCount(plan)}…` : state === 'built' ? `Planned ${stepCount(plan)}` : 'Plan not built'}</span>
          {!working && <ChevronRight className={cn('size-3.5 shrink-0 text-t3 transition-transform motion-reduce:transition-none', open && 'rotate-90')} />}
        </button>
        <Collapsible open={open && !working}>
          <ol className="space-y-1 pt-1.5">
            {plan.steps.map((step, i) => (
              <li key={step.key} className="flex items-start gap-1.5 text-[12px] leading-snug text-t2">
                <span className="w-4 shrink-0 text-right text-t3">{i + 1}.</span>
                <span className="min-w-0 [overflow-wrap:anywhere]">
                  {step.does || step.name} <span className="text-t3">({label(step.type)})</span>
                </span>
              </li>
            ))}
          </ol>
        </Collapsible>
      </div>
    );
  }

  return (
    <div className="animate-fade-up space-y-2 rounded-xl border border-acbd bg-sf p-2.5">
      <div className="text-[13px] font-semibold leading-snug text-t1">
        Plan: {plan.name} · {stepCount(plan)}
      </div>
      <ol className="space-y-1.5">
        {plan.steps.map((step, i) => {
          const options = alternatives[step.key] ?? [];
          const info = nodeTypes[step.type]?.descriptor;
          return (
            <li key={step.key} className="flex items-start gap-1.5" data-step={step.key}>
              <span className="mt-0.5 w-4 shrink-0 text-right text-[12px] text-t3">{i + 1}.</span>
              <NodeIcon icon={info?.icon} size={16} className="mt-0.5 shrink-0 text-t2" />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] leading-snug text-t1 [overflow-wrap:anywhere]">{step.does || step.name}</div>
                {options.length ? (
                  <select
                    aria-label={`Node for step ${i + 1}`}
                    value={step.type}
                    onChange={(e) => edit(itemId, (p) => ({ ...p, plan: swapStep(p.plan, step.key, e.target.value) }))}
                    className="mt-0.5 max-w-full rounded-md border border-hair bg-transparent py-0.5 pl-1 pr-0.5 text-[11.5px] text-t3 hover:text-t2 max-md:min-h-9"
                  >
                    <option value={step.type}>{label(step.type)}</option>
                    {options.map((o) => (
                      <option key={o.type} value={o.type}>
                        {o.displayName}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="text-[11.5px] text-t3">{label(step.type)}</div>
                )}
              </div>
              {i > 0 && (
                <button
                  type="button"
                  aria-label={`Remove step ${i + 1}`}
                  onClick={() => edit(itemId, (p) => ({ ...p, plan: dropStep(p.plan, step.key) }))}
                  className="-my-0.5 grid size-7 shrink-0 place-items-center rounded-full text-t3 hover:bg-acdim hover:text-t1 max-md:size-11"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          );
        })}
      </ol>
      {plan.assumptions.map((line, i) => (
        <p key={`a${i}`} className="text-[12px] leading-snug text-t2 [overflow-wrap:anywhere]">
          <span className="font-semibold">Assumed:</span> {line}
        </p>
      ))}
      {plan.cannot.map((line, i) => (
        <p key={`c${i}`} className="text-[12px] leading-snug text-t2 [overflow-wrap:anywhere]">
          <span className="font-semibold text-warn">Not possible here:</span> {line}
        </p>
      ))}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <input
          value={change}
          onChange={(e) => setChange(e.target.value)}
          maxLength={500}
          disabled={busy}
          placeholder="Change the plan…"
          aria-label="Change the plan"
          className="min-h-7 min-w-0 flex-1 rounded-lg border border-hair bg-transparent px-2 text-[12.5px] text-t1 placeholder:text-t3 max-md:min-h-11"
        />
        {busy && <Loader2 className="size-3.5 shrink-0 animate-spin text-t3" />}
      </form>
      {problem && <p className="text-[12px] text-rd [overflow-wrap:anywhere]">{problem}</p>}
      <Button size="sm" variant="primary" disabled={busy || plan.steps.length === 0} onClick={() => buildIt(itemId)}>
        Build it
      </Button>
    </div>
  );
}
