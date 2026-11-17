/**
 * The plan card's state and what the person's edits do to it (docs/assistant.md "Building a flow in stages"): the plan as
 * the first stage answered it, the other nodes each step may be, and where the card stands. Pure (no zod, no server): the
 * card, the first draft's flow (./draft-flow.ts) and their tests share it.
 */
import type { BuildPlan } from '@/lib/shared/build-plan';
import { withoutStep } from '@/lib/shared/plan-edit';
import { useAssistant } from '../assistant';

export interface PlanPart {
  plan: BuildPlan;
  /** For each step (by key): other node types the search ranked for its words, the card's menu. */
  alternatives: Record<string, Array<{ type: string; displayName: string }>>;
  /** `waiting`: for Build it; `building`: the card folds to one line; `built`; `stopped`. */
  state: 'waiting' | 'building' | 'built' | 'stopped';
  /** What was asked: the plan route needs it for a correction. */
  prompt: string;
}

/** The plan without a step (its attached sub-nodes go with it); see `withoutStep`. */
export const dropStep = withoutStep;

/** The plan with another node type for one step (its words stay). */
export function swapStep(plan: BuildPlan, key: string, type: string): BuildPlan {
  return { ...plan, steps: plan.steps.map((s) => (s.key === key ? { ...s, type } : s)) };
}

/** The plan's step count in words: "7 steps". */
export const stepCount = (plan: BuildPlan) => `${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}`;

/** Build it waits here: the first draft's flow holds each plan card's wish until the person agrees (or stops it). */
const waiting = new Map<string, (plan: BuildPlan | undefined) => void>();

/** Wait for the card's Build it: the plan to build, or undefined when stopped. */
export function waitForBuildIt(itemId: string, signal: AbortSignal): Promise<BuildPlan | undefined> {
  return new Promise((resolve) => {
    waiting.set(itemId, (plan) => (waiting.delete(itemId), resolve(plan)));
    if (signal.aborted) return waiting.get(itemId)?.(undefined);
    signal.addEventListener('abort', () => waiting.get(itemId)?.(undefined), { once: true });
  });
}

/** The card's Build it: the draft goes on with the plan the card holds now (edits included). False when nothing waits for it. */
export function buildIt(itemId: string): boolean {
  const item = useAssistant.getState().items.find((i) => i.id === itemId);
  const part = item?.role === 'assistant' ? item.parts.find((p) => p.kind === 'plan') : undefined;
  const release = waiting.get(itemId);
  if (!release || part?.kind !== 'plan' || !part.plan.plan.steps.length) return false;
  release(part.plan.plan);
  return true;
}
