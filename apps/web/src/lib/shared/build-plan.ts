/**
 * The first draft's plan (wave sb3, docs/assistant.md "Building a flow in stages"): the steps in words, one node type
 * each, before any parameter is written. Stage 1 (SB13, `lib/server/assistant/build-plan.ts`) asks the model for a
 * `BuildPlan`, choosing each type from a search over the catalog, and the person can correct it on the plan card.
 * Stage 2 (SB14, `lib/server/assistant/build-nodes.ts`) fills each step's parameters in its own small call and wires the
 * steps from the plan, in code (`planEdges`). The summary (SB15) reads the plan's words, assumptions and `cannot`.
 *
 * Contract file: backbone/contracts/sb3/build-plan.ts, copied byte for byte to apps/web/src/lib/shared/build-plan.ts by
 * SB13 (owner), SB14 and SB15. Change it in the contracts folder first (the owner only), then copy. Types and pure
 * helpers only: no import, no zod (the browser loads it for the plan card), no I/O, no prompt text.
 */

/** At most this many steps, the trigger included: a bigger plan is cut and the rest named in `cannot`. */
export const PLAN_STEP_LIMIT = 12;
/** How many `assumptions` and how many `cannot` lines a plan carries (the build route's `PlanSchema` allows this many of each). */
export const PLAN_LINES_LIMIT = 30;

/** The largest prompt one model call of a build may send (plan or node), in tokens (spotlight-pro/plan.md §5, SB13). */
export const PROMPT_TOKEN_BUDGET = 6000;

/** One step of the plan; the draft node built for it has the same `key`. */
export interface PlanStep {
  /** Unique in the plan: `s1`, `s2` … (the trigger is always `s1`). */
  key: string;
  /** The node type chosen for it: one the plan stage offered (allowed for the workflow), never a guess. */
  type: string;
  /** Its name on the canvas, 2–4 words ("Get new bug issues"). */
  name: string;
  /** What it does here, one sentence in the person's words: the plan card's and the summary's line. */
  does: string;
  /** The step it follows (its key). Absent only on the trigger. */
  from?: string;
  /** Which output of `from` feeds it (If and Filter: 0 true, 1 false; Switch: the rule's index). Default 0. */
  output?: number;
  /**
   * A sub-node (chat model, memory, tool, retriever …) attached to `from` instead of a main step: its connection type
   * (`ai_languageModel`, `ai_memory`, `ai_tool` …). The edge goes from this step to `from`, as the canvas draws it.
   */
  attach?: string;
  /** The input fields it reads, as `$json` paths without the prefix (`issues`, `body.total`), when it reads any. */
  reads?: string[];
}

export interface BuildPlan {
  /** The workflow's name, at most 80 characters. */
  name: string;
  /** In order: `steps[0]` is the one trigger (no `from`); every other step has a `from` that comes before it. */
  steps: PlanStep[];
  /** What the plan took for granted, one line each ("“every morning” read as 8:00 every day"). */
  assumptions: string[];
  /** What the request asks that no node here can do ("post to Microsoft Teams: no Teams node is installed"). */
  cannot: string[];
}

/** One model call of a build, as the draft reports it (`FlowDraft.stages`): never its text. */
export interface BuildStage {
  /** `plan` (SB13), `node` (SB14, one per step), `send-back` (a second try of either), `one-shot` (the base's whole-draft call, kept as a fallback). */
  stage: 'plan' | 'node' | 'send-back' | 'one-shot';
  /** For `node` and its `send-back`: the plan step's key. */
  step?: string;
  /** As the provider reported them (AI usage's own numbers); 0 when it reported none. */
  inputTokens: number;
  outputTokens: number;
  /** The request's length in characters (system prompt and messages), never its text: Ollama reports fewer input tokens when it reused a cached prefix, so the budget check also reads this. */
  promptChars: number;
  ms: number;
}

/** What is wrong with a plan, for a send-back or the card: the step it is about, and the problem in words. */
export interface PlanProblem {
  step?: string;
  problem: string;
}

/** A rough token count from characters (four per token), the check on a provider's own count. */
export function estimatedTokens(chars: number): number {
  return Math.ceil(Math.max(0, chars) / 4);
}

/** The largest prompt of a build, in tokens: per call the greater of the reported count and the estimate. 0 with no calls. */
export function largestPrompt(stages: readonly BuildStage[]): number {
  return stages.reduce((most, s) => Math.max(most, s.inputTokens, estimatedTokens(s.promptChars)), 0);
}

/**
 * Everything that keeps a plan from being built as it is: no steps, a first step that is not a trigger, a second
 * trigger, a type not offered, a repeated key, a `from` that is missing or comes later, more than `PLAN_STEP_LIMIT`
 * steps. `offered` is the set of types the plan stage offered; `isTrigger` tells a trigger type. Empty: build it.
 */
export function planProblems(plan: BuildPlan, offered: ReadonlySet<string>, isTrigger: (type: string) => boolean): PlanProblem[] {
  const problems: PlanProblem[] = [];
  if (!plan.steps.length) return [{ problem: 'the plan has no steps' }];
  if (plan.steps.length > PLAN_STEP_LIMIT) problems.push({ problem: `the plan has ${plan.steps.length} steps; at most ${PLAN_STEP_LIMIT}` });
  const seen = new Set<string>();
  plan.steps.forEach((step, index) => {
    if (seen.has(step.key)) problems.push({ step: step.key, problem: `the key “${step.key}” is used twice` });
    if (!offered.has(step.type)) problems.push({ step: step.key, problem: `“${step.type}” is not one of the node types offered` });
    if (index === 0) {
      if (!isTrigger(step.type)) problems.push({ step: step.key, problem: 'the first step must be the trigger' });
      if (step.from) problems.push({ step: step.key, problem: 'the trigger follows no step' });
    } else {
      if (isTrigger(step.type)) problems.push({ step: step.key, problem: 'a flow has one trigger; this is a second' });
      if (!step.from) problems.push({ step: step.key, problem: 'it follows no step' });
      else if (!seen.has(step.from)) problems.push({ step: step.key, problem: `it follows “${step.from}”, which is not a step before it` });
    }
    seen.add(step.key);
  });
  return problems;
}

/**
 * The plan's wiring, in the draft's edge form `[source, target, output, type]`: a main step from its `from` (on its
 * `output`), a sub-node from itself to its `from` (on output 0, with its `attach` type). Steps without `from` add none.
 */
export function planEdges(plan: BuildPlan): Array<[string, string, number, string]> {
  return plan.steps.flatMap((step): Array<[string, string, number, string]> => {
    if (!step.from) return [];
    return step.attach ? [[step.key, step.from, 0, step.attach]] : [[step.from, step.key, step.output ?? 0, 'main']];
  });
}

/** The plan as numbered lines for the card and the summary: "1. Every weekday at 8 (Schedule Trigger)". `label` names a type. */
export function planLines(plan: BuildPlan, label: (type: string) => string = (type) => type): string[] {
  return plan.steps.map((step, index) => `${index + 1}. ${step.does || step.name} (${label(step.type)})`);
}
