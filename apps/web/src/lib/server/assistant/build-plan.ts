/**
 * Stage 1 of a first draft (wave sb3, docs/assistant.md "Building a flow in stages"): the steps in words, one node type
 * each, chosen from a search over the catalog and checked before anything is built. The model is sent the candidates the
 * request's own words found (one line each), never the whole catalog and never a node's properties; what it answers is a
 * `BuildPlan` (lib/shared/build-plan.ts), which is checked with `planProblems`, sent back once in words and, if still
 * wrong, repaired in code with an `assumptions` line for each repair. A step whose type no offered node can stand in for
 * is dropped and named in `cannot`.
 */
import { z } from 'zod';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { describeAgents, type AgentBrief } from '@/lib/shared/agent-brief';
import { describeTeams, type TeamBrief } from '@/lib/shared/agent-teams';
import { PLAN_LINES_LIMIT, PLAN_STEP_LIMIT, planProblems, type BuildPlan, type BuildStage, type PlanProblem, type PlanStep } from '@/lib/shared/build-plan';
import { askModel, buildFlow, builderTimeoutMs, jsonOf, type FlowDraft } from '../flow-builder';
import { availableTypes, catalogSummary, searchNodes } from './research';
import { names as triggerNamed } from './draft-guards';

/** At most this many non-trigger candidates are offered (the triggers come with them). */
export const CANDIDATE_LIMIT = 24;
/** A hit scores 4 or more when a word of the request is in a node's name or type: a lower score is a word in its description. */
const MIN_SCORE = 4;

const FILLER = new Set('the and for with each when its into from that this then them they their what which who your you any all are was has have not but per one two also only must should will can new'.split(' '));

/** A request's own words for a node search: two-letter words ("to", "on") are inside half the node names. */
export const searchWords = (value: string | undefined): string =>
  (value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !FILLER.has(w))
    .join(' ');

/** The request's clauses ("then", commas, semicolons, "if", "otherwise"), each a search of its own. */
export function clausesOf(prompt: string): string[] {
  return prompt
    .split(/\band then\b|\bthen\b|[,;]|\bif\b|\botherwise\b/i)
    .map(searchWords)
    .filter(Boolean);
}

/**
 * The built-in glue every flow may need and a request rarely names ("if the total is over 1000" has no word of If in it):
 * offered whatever the search finds, counted in the limit.
 */
const GLUE = ['core.if', 'core.filter', 'core.switch', 'core.set', 'core.code', 'core.merge', 'core.httpRequest'];

const isTriggerInfo = (t: NodeTypeInfo | undefined) => t?.descriptor.kind === 'trigger';
const isSubnodeInfo = (t: NodeTypeInfo | undefined) => t?.descriptor.kind === 'subnode';

/** A step without `attach` must not be a sub-node type (it would be built as a main step); `lookup` tells a type's info. */
export function subnodeProblems(plan: BuildPlan, lookup: (type: string) => NodeTypeInfo | undefined): PlanProblem[] {
  return plan.steps.flatMap((step): PlanProblem[] => {
    const info = lookup(step.type);
    if (!step.attach) return isSubnodeInfo(info) ? [{ step: step.key, problem: `“${step.type}” is a sub-node: it must be attached to an agent step (“attach”), not a step of its own in the flow` }] : [];
    // An attached step must supply the connection it attaches by (a chat model as ai_languageModel, never Slack).
    return info && !attachFits(info, step.attach) ? [{ step: step.key, problem: `“${step.type}” cannot be attached as ${step.attach}${suppliesOf(info).length ? `: it supplies ${suppliesOf(info).join(', ')}` : ': it is not a sub-node'}` }] : [];
  });
}

const suppliesOf = (t: NodeTypeInfo) => [t.descriptor.supplies ?? []].flat() as string[];
/**
 * Whether a node can be attached by this connection: a sub-node whose `supplies` has it (a sub-node that names none
 * fits any), or, as an agent's tool (`ai_tool`), an action node that is not opted out (`usableAsTool`).
 */
const attachFits = (t: NodeTypeInfo, attach: string) =>
  isSubnodeInfo(t) ? !suppliesOf(t).length || suppliesOf(t).includes(attach) : attach === 'ai_tool' && t.descriptor.kind === 'action' && t.descriptor.usableAsTool !== false;

export interface Candidates {
  /** The types offered to the model, triggers first. */
  types: NodeTypeInfo[];
}

/**
 * The types worth offering for a request: the best hits of a search over its words and each clause (at most 6 a query, a
 * score of 4 or more, at most `CANDIDATE_LIMIT` in all), the triggers (the built-in ones and any a plugin trigger search
 * finds, and always the manual trigger), and the agent and team steps when the person has agents or teams. Only types in
 * `types` (the workflow's allowed ones) are ever offered.
 */
export function candidatesFor(prompt: string, types: NodeTypeInfo[], options: { agents?: boolean; teams?: boolean } = {}): Candidates {
  const byType = new Map(types.map((t) => [t.type, t]));
  const chosen = new Map<string, NodeTypeInfo>();
  const queries = [searchWords(prompt), ...clausesOf(prompt)].filter(Boolean);
  const nodes = types.filter((t) => !isTriggerInfo(t));
  for (const type of GLUE) if (byType.has(type)) chosen.set(type, byType.get(type)!);
  // Round-robin over the queries, so one long clause cannot use up the limit before the others are searched.
  const hits = queries.map((q) => searchNodes(q, nodes, 6).filter((h) => h.score >= MIN_SCORE));
  for (let rank = 0; rank < 6; rank++) {
    for (const list of hits) {
      const hit = list[rank];
      if (hit && !chosen.has(hit.type) && chosen.size < CANDIDATE_LIMIT) chosen.set(hit.type, byType.get(hit.type)!);
    }
  }
  for (const type of [options.agents && 'core.messageAgent', options.teams && 'core.runTeam']) {
    const info = type ? byType.get(type) : undefined;
    if (info && !chosen.has(info.type)) chosen.set(info.type, info);
  }
  const triggers = new Map<string, NodeTypeInfo>();
  const manual = byType.get('core.manualTrigger');
  const triggerTypes = types.filter(isTriggerInfo);
  for (const info of triggerTypes) if (info.pluginId === 'core') triggers.set(info.type, info);
  for (const hit of searchNodes(searchWords(prompt), triggerTypes, 6)) if (hit.score >= MIN_SCORE) triggers.set(hit.type, byType.get(hit.type)!);
  if (manual) triggers.set(manual.type, manual);
  return { types: [...triggers.values(), ...chosen.values()] };
}

const line = (t: NodeTypeInfo) => `${t.type}: ${t.descriptor.displayName} — ${t.descriptor.description.replace(/\s+/g, ' ').slice(0, 80)}`;

const PLAN_SYSTEM = `You plan workflows for Landflow, an n8n-like automation tool. You do not build the workflow yet: you list its steps, in words, one node type each. Reply with JSON only.

A plan is: one trigger first, then the steps in order. Items (JSON objects) flow from each step to the next.
- "steps": the first step is the one trigger (use core.manualTrigger unless the request names a webhook, a schedule, a chat or a form), every other step has a "from": the key of the step it follows (a step that runs after an If or Filter on its false branch adds "output": 1). Keys are "s1", "s2" and so on, the trigger "s1". At most ${PLAN_STEP_LIMIT} steps.
- "type": exactly one of the node types listed under "Node types offered"; never a type that is not listed. Prefer a node of an app (Linear, Slack) over a generic one when it does the job.
- Exactly one trigger node: the event that starts the flow (a schedule, a webhook, a chat message, a form, a new record an app reports). Reading or listing records is a step, not a trigger: "every morning, read new Linear issues" is a schedule trigger and then the Linear node that reads the issues. An app's own trigger node is a second trigger, so do not add one for it.
- Add no step the request does not ask for: no Set, Code or formatting step just to reshape data (the step that needs a field reads it itself).
- "name": 2–4 words for the canvas. "does": one sentence in the person's words saying what the step does here. "reads": the item fields the step reads, when you know them (like "issues" or "body.total").
- A chat model, memory or tool for an agent step is its own step with "attach" ("ai_languageModel", "ai_memory" or "ai_tool") and "from" the agent's key.
- "assumptions": what the request leaves open that you took for granted, one short line each ("every weekday at 8 read as 8:00 on weekdays"). Leave it empty when nothing was open.
- "cannot": what the request asks that none of the node types offered can do, one line each ("post to Microsoft Teams: no Teams node is offered"). Never make up a step or a type for it.
- Agents: when a step needs an agent and one of "Your agents" or "Published agent teams" fits, use core.messageAgent (or core.runTeam) for it; otherwise core.aiAgent for a small step (classify, summarise, draft). Say which in "does".

Reply with one JSON object and nothing else: {"name": string, "steps": [{"key": string, "type": string, "name": string, "does": string, "from"?: string, "output"?: number, "attach"?: string, "reads"?: string[]}], "assumptions": string[], "cannot": string[]}`;

// Lenient where models vary (a number for a key, a string where a list is), strict where a plan cannot be read.
const Key = z.union([z.string(), z.number().transform(String)]);
const Strings = z.array(z.unknown()).nullish().transform((v) => (v ?? []).filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, 300)));
const Step = z.object({
  key: Key,
  type: z.string(),
  name: z.string().nullish().transform((v) => v?.trim().slice(0, 60) ?? ''),
  does: z.string().nullish().transform((v) => v?.trim().slice(0, 300) ?? ''),
  from: Key.nullish().transform((v) => v ?? undefined),
  output: z.union([z.number(), z.string().regex(/^\d+$/).transform(Number)]).nullish().catch(undefined),
  attach: z.string().nullish().transform((v) => v || undefined),
  reads: z.array(z.unknown()).nullish().catch(undefined),
});
const PlanReply = z.object({
  name: z.string().nullish().catch(undefined),
  steps: z.array(Step),
  assumptions: Strings.catch([]),
  cannot: Strings.catch([]),
});

/** A reply as a plan, or what is wrong with it in words. */
export function parsePlan(text: string): { ok: true; plan: BuildPlan } | { ok: false; problems: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonOf(text));
  } catch {
    return { ok: false, problems: 'it is not valid JSON' };
  }
  const parsed = PlanReply.safeParse(raw);
  if (!parsed.success) return { ok: false, problems: parsed.error.issues.slice(0, 3).map((i) => `${i.path.length ? `“${i.path.join('.')}”` : 'the reply'}: ${i.message}`).join('; ') };
  const { name, steps, assumptions, cannot } = parsed.data;
  return {
    ok: true,
    plan: {
      name: (name?.trim() || 'Generated workflow').slice(0, 80),
      steps: steps.map((s): PlanStep => ({
        key: s.key,
        type: s.type,
        name: s.name || s.type,
        does: s.does,
        ...(s.from && { from: s.from }),
        ...(typeof s.output === 'number' && s.output > 0 && { output: s.output }),
        ...(s.attach && { attach: s.attach }),
        ...(s.reads?.length && { reads: s.reads.filter((r): r is string => typeof r === 'string').slice(0, 12) }),
      })),
      assumptions,
      cannot,
    },
  };
}

/** A type the model made up is replaced only by an offered node whose name, or whose type's last word, is a word of the step: never by a loose match. */
export function standIn(step: PlanStep, pool: NodeTypeInfo[]): string | undefined {
  const squash = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, '');
  const words = new Set(`${step.name} ${step.does} ${step.type.split('.').pop()}`.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2));
  return pool.find((t) => words.has(squash(t.descriptor.displayName)) || words.has(squash(t.type.split('.').pop()!)))?.type;
}

export interface RepairContext {
  offered: ReadonlyMap<string, NodeTypeInfo>;
  isTrigger: (type: string) => boolean;
  /** Tells a sub-node type: one used as a main step (no `attach`) is replaced like a type that is not offered. */
  isSubnode?: (type: string) => boolean;
  /** Whether a type can be attached by this connection (`attach`): false drops the step. Absent: any. */
  attachFits?: (type: string, attach: string) => boolean;
  /** The best offered type for a step's words (a trigger for the first step), or undefined. */
  stand: (step: PlanStep, asTrigger: boolean) => string | undefined;
  /** Integration (sb3): whether the request names this trigger type: of two triggers that one stays (SB02's rule for drafts), else the first. */
  named?: (type: string) => boolean;
}

/**
 * What is still wrong with a plan, put right in code, each repair a line in `assumptions` (never silent): a second
 * trigger is dropped and its children follow the first, a type that is not offered is replaced by the best search hit for
 * the step's words or the step is dropped and named in `cannot`, a step with no valid `from` follows the one before it,
 * a first step that is no trigger gets a manual trigger before it, the plan is cut at the limit. Keys end up `s1`, `s2` ….
 */
export function repairPlan(input: BuildPlan, ctx: RepairContext): BuildPlan {
  const notes: string[] = [];
  const cannot = [...input.cannot];
  let steps = input.steps.map((s) => ({ ...s }));
  // Repeated keys: the later one gets a new key; what follows it by the old key follows the first.
  const seenKeys = new Set<string>();
  steps = steps.map((s, i) => {
    if (!seenKeys.has(s.key)) return (seenKeys.add(s.key), s);
    const key = `${s.key}-${i + 1}`;
    notes.push(`two steps were both called “${s.key}”: the second is “${key}”`);
    seenKeys.add(key);
    return { ...s, key };
  });
  // Unknown types.
  const kept: PlanStep[] = [];
  const dropped = new Map<string, PlanStep>();
  for (const [index, s] of steps.entries()) {
    // An offered type attached by a connection it does not supply is no stand-in's to fix: the step goes, named.
    const misattached = Boolean(s.attach && ctx.offered.has(s.type) && ctx.attachFits && !ctx.attachFits(s.type, s.attach));
    if (!misattached && ctx.offered.has(s.type) && (s.attach || !ctx.isSubnode?.(s.type))) {
      kept.push(s);
      continue;
    }
    const stand = misattached ? undefined : ctx.stand(s, index === 0);
    if (stand) {
      notes.push(`“${s.name}” was planned as ${s.type}, which is not a node here: ${ctx.offered.get(stand)!.descriptor.displayName} stands in for it`);
      kept.push({ ...s, type: stand });
    } else {
      dropped.set(s.key, s);
      cannot.push(`${s.name || s.type}: no node here does this${s.does ? ` (${s.does.replace(/[.\s]+$/, '')})` : ''}`);
    }
  }
  // A dropped step's children follow its own `from`.
  const resolve = (from: string | undefined): string | undefined => {
    let at = from;
    for (let i = 0; at && dropped.has(at) && i < 20; i++) at = dropped.get(at)!.from;
    return at;
  };
  steps = kept.map((s) => (s.from && dropped.has(s.from) ? { ...s, from: resolve(s.from) } : s));
  // The trigger: the one the request names leads (else the first), another goes and its children follow the one kept.
  const triggers = steps.filter((s) => ctx.isTrigger(s.type));
  const first = triggers.find((s) => ctx.named?.(s.type)) ?? triggers[0];
  if (!first) {
    const manual = ctx.offered.has('core.manualTrigger') ? 'core.manualTrigger' : [...ctx.offered.keys()].find(ctx.isTrigger);
    if (manual) {
      notes.push('the plan named no trigger: it starts by hand');
      steps = [{ key: 'trigger', type: manual, name: 'Start', does: 'Start the flow by hand' }, ...steps.map((s) => (s.from ? s : { ...s, from: 'trigger' }))];
    }
  } else {
    const others = triggers.filter((s) => s !== first);
    for (const extra of others) notes.push(`the plan had a second trigger (${extra.name}): the flow has one, ${first.name}`);
    const extras = new Set(others.map((s) => s.key));
    steps = [first, ...steps.filter((s) => s !== first && !extras.has(s.key))].map((s) => (s.from && extras.has(s.from) ? { ...s, from: first.key } : s));
  }
  // `from`: an earlier step; the trigger has none.
  const before = new Set<string>();
  steps = steps.map((s, i) => {
    let next = s;
    if (i === 0) {
      if (s.from) {
        const { from: _from, ...rest } = s;
        next = rest;
      }
    } else if (!s.from || !before.has(s.from)) {
      const follows = steps[i - 1].key;
      notes.push(`“${s.name}” follows ${before.has(s.from ?? '') ? s.from : `“${steps[i - 1].name}”`}: the plan did not say what it follows`);
      next = { ...s, from: follows };
    }
    before.add(s.key);
    return next;
  });
  if (steps.length > PLAN_STEP_LIMIT) {
    for (const s of steps.slice(PLAN_STEP_LIMIT)) cannot.push(`${s.name || s.type}: the plan is cut at ${PLAN_STEP_LIMIT} steps`);
    steps = steps.slice(0, PLAN_STEP_LIMIT);
  }
  // Keys s1, s2 …, with `from` re-pointed.
  const rekey = new Map(steps.map((s, i) => [s.key, `s${i + 1}`]));
  steps = steps.map((s) => ({ ...s, key: rekey.get(s.key)!, ...(s.from && { from: rekey.get(s.from) ?? s.from }) }));
  // What the build route accepts back (`PlanSchema`): a plan this route returns always parses there.
  const line = (text: string) => text.trim().slice(0, 300);
  steps = steps.map((s) => ({
    ...s,
    ...(typeof s.output === 'number' && { output: Math.min(50, Math.max(0, Math.trunc(s.output))) }),
    ...(s.attach && { attach: s.attach.slice(0, 40) }),
    ...(s.reads && { reads: s.reads.map((r) => r.trim().slice(0, 80)).filter(Boolean).slice(0, 12) }),
  }));
  return { name: input.name.slice(0, 80), steps, assumptions: [...input.assumptions, ...notes].map(line).slice(0, PLAN_LINES_LIMIT), cannot: cannot.map(line).slice(0, PLAN_LINES_LIMIT) };
}

export interface PlanInput {
  model: string;
  /** The workflow's allowed types (SB02's filter): only these are ever offered. */
  types: NodeTypeInfo[];
  agents?: readonly AgentBrief[];
  teams?: readonly TeamBrief[];
  signal?: AbortSignal;
  /** Where each model call of the plan is recorded (`stage: 'plan'`, or `send-back`). */
  stages: BuildStage[];
  /** With `change`: the plan the person corrects. */
  plan?: BuildPlan;
  /** The correction, in the person's words. */
  change?: string;
}

export interface PlanResult {
  plan: BuildPlan;
  /** For each step (by key): other offered types the search ranked for its words, the card's choice. */
  alternatives: Record<string, Array<{ type: string; displayName: string }>>;
}

const problemsText = (problems: PlanProblem[]) => problems.map((p) => `${p.step ? `${p.step}: ` : ''}${p.problem}`).join('; ');

/** A word without its plural or -ing ending, so "posts" and "post" meet. */
const stem = (w: string) => w.replace(/(ing|es|s)$/, '');

/** For each step, up to three other offered types the search ranks for its words (a trigger only among triggers). */
export function alternativesFor(plan: BuildPlan, offered: ReadonlyMap<string, NodeTypeInfo>, all: NodeTypeInfo[]): PlanResult['alternatives'] {
  const out: PlanResult['alternatives'] = {};
  plan.steps.forEach((step, index) => {
    // A trigger only among triggers; a main step only among main steps; an attached sub-node only among sub-nodes.
    const supplies = suppliesOf;
    const own0 = all.find((t) => t.type === step.type);
    const pool = all.filter((t) => {
      if (t.type === step.type) return false;
      if (index === 0) return isTriggerInfo(t);
      if (step.attach) return isSubnodeInfo(t) && (!own0 || !supplies(own0).length || supplies(t).some((x) => supplies(own0).includes(x)));
      return !isTriggerInfo(t) && !isSubnodeInfo(t);
    });
    const words = new Set(searchWords(`${step.name} ${step.does}`).split(' ').map(stem));
    // Only a node one of whose own words (name, type, keywords) is a word of the step: "post" is not "Postgres".
    const near = pool.filter((t) => [t.descriptor.displayName, t.type.split('.').pop() ?? '', ...(t.descriptor.keywords ?? [])].join(' ').toLowerCase().split(/[^a-z0-9]+/).some((w) => w.length > 2 && words.has(stem(w))));
    const hits = searchNodes([...words].join(' '), near, 3).filter((h) => h.score >= MIN_SCORE);
    const own = new Map(pool.map((t) => [t.type, t]));
    const list = hits.map((h) => ({ type: h.type, displayName: own.get(h.type)?.descriptor.displayName ?? h.displayName }));
    // A trigger step always may be any of the offered triggers.
    if (index === 0) for (const t of offered.values()) if (isTriggerInfo(t) && t.type !== step.type && !list.some((l) => l.type === t.type) && list.length < 3) list.push({ type: t.type, displayName: t.descriptor.displayName });
    if (list.length) out[step.key] = list.slice(0, 3);
  });
  return out;
}

/**
 * Wave sb3 integration: a first draft, planned first. With no `plan` it plans (stage 1, `planFlow`) and then builds in
 * stages (SB14, `buildFlow` with the plan) inside one time budget (`LANDFLOW_BUILDER_TIMEOUT_SECONDS` counts from the plan's
 * start), the calls and their stages counted together; with a `plan` it builds from
 * that plan; `staged: false` is SB13's one-shot draft (`buildFlow` with no plan). The build route and the brain writer
 * call this. It lives here, not in flow-builder.ts, since this module imports flow-builder.ts (no import cycle).
 */
export async function buildPlanFirst(prompt: string, model: string, teams: readonly TeamBrief[] = [], agents: readonly AgentBrief[] = [], options: { types?: NodeTypeInfo[]; plan?: BuildPlan; staged?: boolean } = {}): Promise<FlowDraft> {
  const { staged, ...rest } = options;
  if (rest.plan || staged === false) return buildFlow(prompt, model, teams, agents, rest);
  const started = Date.now();
  const planStages: BuildStage[] = [];
  const { plan } = await planFlow(prompt, { model, types: rest.types ?? availableTypes(), agents, teams, stages: planStages });
  // One budget for the whole draft (LANDFLOW_BUILDER_TIMEOUT_SECONDS): the build starts from the plan's start, not afresh.
  const built = await buildFlow(prompt, model, teams, agents, { ...rest, plan, started });
  return { ...built, durationMs: Date.now() - started, calls: planStages.length + (built.calls ?? 0), stages: [...planStages, ...(built.stages ?? [])] };
}

/** Stage 1: the plan for a request (or, with `plan` and `change`, the plan as the person corrected it). */
export async function planFlow(prompt: string, input: PlanInput): Promise<PlanResult> {
  const { model, types, stages } = input;
  const agents = input.agents ?? [];
  const teams = input.teams ?? [];
  const candidates = candidatesFor(prompt, types, { agents: agents.length > 0, teams: teams.length > 0 });
  // A correction may name a node the request did not: it is searched too.
  const extra = input.change ? candidatesFor(`${prompt}. ${input.change}`, types, { agents: agents.length > 0, teams: teams.length > 0 }) : undefined;
  const offeredList = [...new Map([...candidates.types, ...(extra?.types ?? []), ...(input.plan?.steps.flatMap((s) => types.filter((t) => t.type === s.type)) ?? [])].map((t) => [t.type, t])).values()];
  const offered = new Map(offeredList.map((t) => [t.type, t]));
  const isTrigger = (type: string) => isTriggerInfo(offered.get(type) ?? types.find((t) => t.type === type));
  const agentsNote = offered.has('core.messageAgent') && agents.length ? `\n\nYour agents (core.messageAgent: the agent's id goes in the node later; plan the step, name the agent in "does"):\n${describeAgents(agents)}` : '';
  const teamsNote = offered.has('core.runTeam') && teams.length ? `\n\nPublished agent teams (core.runTeam):\n${describeTeams([...teams])}` : '';
  const current = input.plan && input.change ? `\n\nThe current plan:\n${JSON.stringify({ name: input.plan.name, steps: input.plan.steps.map(({ key, type, name, does, from, output, attach }) => ({ key, type, name, does, ...(from && { from }), ...(output && { output }), ...(attach && { attach }) })), assumptions: input.plan.assumptions, cannot: input.plan.cannot })}\n\nThe person corrects it: ${input.change}\nAnswer with the whole corrected plan.` : '';
  const request = `Node types offered (use only these):\n${offeredList.map(line).join('\n')}\n\nWhat else is installed, at a glance:\n${catalogSummary(types)}${agentsNote}${teamsNote}\n\nPlan this workflow:\n${prompt}${current}`;
  const started = Date.now();
  const timeoutMs = builderTimeoutMs();
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: request }];
  const ask = (stage: 'plan' | 'send-back', left: number) => askModel(model, messages, left, { stage, stages, system: PLAN_SYSTEM });
  const check = (plan: BuildPlan) => [...planProblems(plan, new Set(offered.keys()), isTrigger), ...subnodeProblems(plan, (type) => offered.get(type) ?? types.find((t) => t.type === type))];

  const first = await ask('plan', timeoutMs);
  messages.push({ role: 'assistant', content: first });
  let parsed = parsePlan(first);
  let plan = parsed.ok ? parsed.plan : undefined;
  let problems = parsed.ok ? check(parsed.plan) : [{ problem: parsed.problems }];
  if (problems.length) {
    // Once, in words; what is still wrong after it is repaired in code.
    messages.push({ role: 'user', content: `That plan cannot be built: ${problemsText(problems)}. Reply again with the whole corrected plan as one JSON object, using only the node types offered.` });
    const left = timeoutMs - (Date.now() - started);
    if (left > 0) {
      const again = await ask('send-back', left);
      parsed = parsePlan(again);
      if (parsed.ok) plan = parsed.plan;
      problems = parsed.ok ? check(parsed.plan) : [{ problem: parsed.problems }];
    }
  }
  if (!plan) throw new Error('The model did not return a usable plan. Try again or rephrase.');
  if (problems.length) {
    plan = repairPlan(plan, {
      offered,
      isTrigger,
      named: (type) => triggerNamed(offered.get(type) ?? types.find((t) => t.type === type), prompt),
      isSubnode: (type) => isSubnodeInfo(offered.get(type)),
      attachFits: (type, attach) => { const info = offered.get(type) ?? types.find((t) => t.type === type); return !info || attachFits(info, attach); },
      stand: (step, asTrigger) => standIn(step, offeredList.filter((t) => isTriggerInfo(t) === asTrigger && !isSubnodeInfo(t))),
    });
    const still = check(plan);
    if (still.length) throw new Error(`The plan cannot be built: ${problemsText(still)}`);
  } else {
    // A valid plan still gets the keys s1, s2 … the card and the build use.
    plan = repairPlan(plan, { offered, isTrigger, stand: () => undefined });
  }
  return { plan, alternatives: alternativesFor(plan, offered, offeredList) };
}
