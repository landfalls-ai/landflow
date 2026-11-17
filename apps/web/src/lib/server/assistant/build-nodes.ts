/**
 * Stage 2 of a first draft (wave sb3, docs/assistant.md "Each step's parameters"): the plan's steps become nodes, one
 * small model call each. The call sees only that node's docs and what really arrives from the step before (its
 * output fields, or the trigger's test items), and its reply is checked before the next step is asked: empty parts,
 * option values, expressions against what the step receives, a schedule's days. A problem goes back once, to that
 * step alone. The wiring is the plan's (`planEdges`), never a model's.
 */
import { withPropertyDefaults } from '@landflow/protocol';
import { z } from 'zod';
import { describeAgents, withAgentId, type AgentBrief } from '@/lib/shared/agent-brief';
import { describeTeams, withTeamId, type TeamBrief } from '@/lib/shared/agent-teams';
import { planEdges, PROMPT_TOKEN_BUDGET, type BuildPlan, type BuildStage, type PlanStep } from '@/lib/shared/build-plan';
import type { DraftLeft } from '@/lib/shared/draft-left';
import type { ConnectionType, NodeItem, NodeTypeInfo, Workflow } from '@/lib/shared/types';
import { withCallNote } from '../ai-usage/call-context';
import { plainDraft } from '../ai-usage/drafts';
import { anthropicModel } from '../nodes/models';
// Type-only: flow-builder calls this module, so the values it shares come in through `options.kit` (no import cycle).
import type { adapterTimedOut, AGENT_TYPES, Assembled, DraftNode, emptyParts, jsonOf, knownAgent, PARAMETER_FORMATS, pinsOnTrigger } from '../flow-builder';
import { assistantModel } from './model';
import { cronProblems, expressionMisses } from './change-checks';
import { registryLookup, validateNodeParameters } from './ops';
import { nodeDocs, outputFields } from './research';

/** One turn of the conversation that fills a step. */
export type StepMessage = { role: 'user' | 'assistant'; content: string };

/** What one model call gave back: its text, and the token counts the provider reported (0 when it reported none). */
export interface StepAnswer {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

/** The one place a step's call reaches the model; the integrator points it at the flow builder's `askModel` (its `note`). */
export type StepAsk = (messages: StepMessage[], budgetMs: number, note: { stage: 'node' | 'send-back'; step: string }) => Promise<StepAnswer>;

/** What the flow builder shares with this stage (its own helpers, passed in so the two modules do not import each other). */
export interface BuildKit {
  emptyParts: typeof emptyParts;
  jsonOf: typeof jsonOf;
  knownAgent: typeof knownAgent;
  pinsOnTrigger: typeof pinsOnTrigger;
  adapterTimedOut: typeof adapterTimedOut;
  AGENT_TYPES: typeof AGENT_TYPES;
  PARAMETER_FORMATS: typeof PARAMETER_FORMATS;
}

export interface BuildFromPlanOptions {
  /** `{ emptyParts, jsonOf, knownAgent, pinsOnTrigger, adapterTimedOut, AGENT_TYPES, PARAMETER_FORMATS }` of lib/server/flow-builder.ts. */
  kit: BuildKit;
  model: string;
  /** The node types the workflow may use. */
  types: NodeTypeInfo[];
  agents?: readonly AgentBrief[];
  teams?: readonly TeamBrief[];
  /** The whole build's bound: what is left of it is each call's. */
  timeoutMs: number;
  started?: number;
  /** Where the calls' sizes are recorded; a fresh list when none. */
  stages?: BuildStage[];
  /** The model call; the default asks `model` through the model adapters, counted in AI usage. */
  ask?: StepAsk;
}

export interface PlanBuilt extends Assembled {
  /** The test items a step wrote, by the step's key (the trigger's, or an app step's after a schedule). */
  testItems: Record<string, NodeItem[]>;
  calls: number;
  stages: BuildStage[];
  started: number;
}

const PASS_THROUGH = new Set(['core.if', 'core.filter', 'core.switch', 'core.noOp', 'core.wait', 'core.limit', 'core.sort']);
/** What a trigger's own item holds, besides what a test item adds. */
const TRIGGER_FIELDS: Record<string, Record<string, unknown>> = {
  'core.schedule': { firedAt: '' },
  'core.webhook': { method: '', path: '', headers: {}, query: {} },
  'core.chatTrigger': { chatInput: '', sessionId: '', action: '' },
};
/** What an agent step writes (nodes/ai.ts, nodes/agents.ts): its answer is `output`, never the fields of the item it read. */
const AGENT_FIELDS: Record<string, Record<string, unknown>> = {
  'core.aiAgent': { output: '', sessionId: '', model: '', iterations: 0, usage: {}, steps: [], fallbackUsed: false },
  'core.messageAgent': { output: '', sessionId: '', model: '', iterations: 0, usage: {}, steps: [], fallbackUsed: false },
};

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

const stepSystem = (formats: string) => `You fill in ONE step of a workflow for Landflow, an n8n-like automation tool. The steps, their types and their order are already decided: you only write this step's parameters. Reply with JSON only.

Items (JSON objects) flow along the connections: this step gets the items of the step before it.

Rules:
- Parameters: only the names listed in the step's docs. Reference fields of the current item with expressions such as "{{ $json.title }}", and only fields listed under "What this step receives": never a field it does not list. Field parameters (like "field") take a plain field name such as "text", not an expression.
- Nodes that write a result object into "outputField" (see the parameter notes) nest it: compare "{{ $json.sentiment.label }}", never the whole object.
- Fill every list or collection this step needs (an If's conditions, a Set's fields, a Switch's rules, a schedule's rule) in the shape below; an empty list is wrong.
- "Every morning" or "every day" means every day: limit a schedule to weekdays only when the request says weekdays.
- Never invent an id, channel, table, repository, address or URL nobody gave: leave that parameter empty.
- Agents: core.messageAgent runs an agent from "Your agents" by its agentId, core.runTeam a team from "Published agent teams" by its teamId, never a name or an invented id. Put in "message" what to do with the item.

${formats}`;

const STEP_SCHEMA = { type: 'object', properties: { parameters: { type: 'object' }, testData: { type: 'array', items: { type: 'object' } } }, required: ['parameters'] };
const systemWithSchema = (formats: string) => `${stepSystem(formats)}\n\nAnswer with one JSON object and nothing else (no prose, no code fence), matching this JSON schema:\n${JSON.stringify(STEP_SCHEMA)}`;

const StepReply = z.object({ parameters: z.record(z.string(), z.unknown()).nullish(), testData: z.array(z.unknown()).nullish().catch(undefined) });

/** The reply as parameters (and test data), or why it cannot be used. A bare parameters object, without the wrapper, is read as the parameters. */
function parseStep(text: string, jsonOf: BuildKit['jsonOf']): { ok: true; parameters: Record<string, unknown>; testData?: unknown[] } | { ok: false; problem: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonOf(text));
  } catch {
    return { ok: false, problem: 'it is not valid JSON' };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, problem: 'it is not one JSON object' };
  const object = raw as Record<string, unknown>;
  const parsed = StepReply.safeParse(object);
  if (!parsed.success) return { ok: false, problem: '"parameters" must be one JSON object' };
  if (parsed.data.parameters) return { ok: true, parameters: parsed.data.parameters, testData: parsed.data.testData ?? undefined };
  const { testData: _testData, ...bare } = object;
  return { ok: true, parameters: bare, testData: parsed.data.testData ?? undefined };
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const plain = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** What reaches a step: where its items come from and which fields they have, as the prompt says it. */
interface Output {
  /** The fields the node declares (`outputFields`). */
  declared: string;
  /** A sample of one item: the trigger's own fields, a Set's fields. */
  sample?: Record<string, unknown>;
  /** The trigger's test items. */
  items?: NodeItem[];
}

const asItems = (rows: unknown): NodeItem[] | undefined => {
  if (!Array.isArray(rows)) return undefined;
  const items = rows.filter(plain).map((json) => ({ json: json as NodeItem['json'] }));
  return items.length ? items.slice(0, 10) : undefined;
};

/** The names a Set node writes. */
function setNames(parameters: Record<string, unknown>): string[] {
  const rows = (parameters.fields as { values?: unknown } | undefined)?.values;
  return Array.isArray(rows) ? rows.flatMap((r) => (plain(r) && typeof r.name === 'string' && r.name ? [r.name] : [])) : [];
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

/** One call through the model adapters (counted in AI usage, `purpose: 'answer'`), with this stage's system prompt. */
async function askStep(kit: BuildKit, model: string, messages: StepMessage[], timeoutMs: number): Promise<StepAnswer> {
  const system = systemWithSchema(kit.PARAMETER_FORMATS);
  const [provider, ...rest] = model.split('/');
  const llm = provider === 'anthropic' ? anthropicModel({ model: rest.join('/'), effort: 'medium', maxTokens: 8_000, fallback: true }) : assistantModel(model);
  const signal = AbortSignal.timeout(timeoutMs);
  const wire = messages.map((m) => (m.role === 'user' ? { role: 'user' as const, content: m.content } : { role: 'assistant' as const, text: m.content, toolCalls: [] }));
  try {
    const turn = await withCallNote({ purpose: 'answer', draft: plainDraft({ system, messages: wire }) }, () => llm.generate({ system, messages: wire, tools: [], responseFormat: 'json', signal }));
    if (turn.stopReason === 'refusal') throw new Error(`${model} declined to draft this step: ${turn.text}`);
    return { text: turn.text || '{}', inputTokens: turn.usage?.inputTokens ?? 0, outputTokens: turn.usage?.outputTokens ?? 0 };
  } catch (e) {
    if (signal.aborted || kit.adapterTimedOut(e)) throw new Error(`${model} did not finish this step in time (LANDFLOW_BUILDER_TIMEOUT_SECONDS bounds the whole draft)`);
    throw e;
  }
}

// ---------------------------------------------------------------------------
// The build
// ---------------------------------------------------------------------------

/** Plan steps as nodes, each filled in its own call; the edges are the plan's. */
export async function buildFromPlan(plan: BuildPlan, prompt: string, options: BuildFromPlanOptions): Promise<PlanBuilt> {
  const { types, timeoutMs, kit } = options;
  const { emptyParts, knownAgent, pinsOnTrigger, AGENT_TYPES } = kit;
  const system = systemWithSchema(kit.PARAMETER_FORMATS);
  const agents = options.agents ?? [];
  const teams = options.teams ?? [];
  const started = options.started ?? Date.now();
  const stages = options.stages ?? [];
  const byType = new Map(types.map((t) => [t.type, t]));
  const lookup = registryLookup(types);
  const ask: StepAsk = options.ask ?? ((messages, budget) => askStep(kit, options.model, messages, budget));
  const budgetLeft = () => timeoutMs - (Date.now() - started);

  const dropped: string[] = [];
  const left: DraftLeft[] = [];
  const nodes: DraftNode[] = [];
  const testItems: Record<string, NodeItem[]> = {};
  const outputs = new Map<string, Output>();
  const stepOf = new Map(plan.steps.map((s) => [s.key, s]));
  let calls = 0;
  let succeeded = 0;
  let firstError: Error | undefined;

  const runsAgent = plan.steps.some((s) => AGENT_TYPES.has(s.type));
  const triggerStep = plan.steps[0];
  const triggerInfo = triggerStep && byType.get(triggerStep.type);

  /** The step whose items really arrive at `step`: the one it follows, past the steps that pass items through unchanged. */
  const dataSource = (step: PlanStep): string | undefined => {
    let from = step.attach ? undefined : step.from;
    // A plan that follows itself would loop here: at most one hop per step.
    for (let hops = 0; from && hops <= plan.steps.length; hops++) {
      const source = stepOf.get(from);
      if (!source || !PASS_THROUGH.has(source.type)) return from;
      from = source.from;
    }
    return undefined;
  };

  const receives = (step: PlanStep): string => {
    if (step.attach) return `Nothing: it is attached to “${stepOf.get(step.from ?? '')?.name ?? 'its step'}” as its ${step.attach.replace(/^ai_/, '')}.`;
    if (!step.from) return 'Nothing: it starts the flow.';
    const key = dataSource(step);
    const out = key ? outputs.get(key) : undefined;
    const name = key ? stepOf.get(key)?.name : undefined;
    const lines: string[] = [];
    if (out?.declared) lines.push(`Each item has: ${out.declared}.`);
    else if (out?.sample) lines.push(`Each item has the fields: ${Object.keys(out.sample).join(', ')}.`);
    if (out?.items) lines.push(`The flow's test items look like: ${clip(JSON.stringify(out.items.slice(0, 2).map((i) => i.json)), 700)}`);
    if (!lines.length) lines.push(`Not declared: “${name ?? 'the step before'}” does not say which fields it writes. Read only fields the request names; never invent one.`);
    return `The items of “${name ?? 'the step before'}”. ${lines.join(' ')}`;
  };

  /** The sample of one item a step writes, for the checks: the trigger's own fields with its test items, a Set's fields. */
  const sampleOf = (key: string): unknown[] | undefined => {
    const out = outputs.get(key);
    if (out?.items?.length) return out.items.map((i) => ({ ...(TRIGGER_FIELDS[stepOf.get(key)?.type ?? ''] ?? {}), ...i.json }));
    return out?.sample ? [out.sample] : undefined;
  };

  /** The flow so far with `node` added: what the sb2 change checks read. */
  const checks = (step: PlanStep, node: DraftNode): string[] => {
    const before: Workflow = { id: 'draft', name: 'Draft', nodes: [], connections: [] };
    const asNode = (n: DraftNode) => ({ id: n.key, name: n.name, type: n.type, typeVersion: 1, position: [0, 0] as [number, number], parameters: n.parameters ?? {} });
    const source = dataSource(step);
    const pinData: Record<string, NodeItem[]> = {};
    for (const key of [...nodes.map((n) => n.key), ...(source ? [source] : [])]) {
      const sample = sampleOf(key);
      if (sample) pinData[key] = sample.map((json) => ({ json: json as NodeItem['json'] }));
    }
    const sourceNode = nodes.find((n) => n.key === source);
    const base: Workflow = { ...before, nodes: nodes.filter((n) => n.key !== node.key).map(asNode), pinData };
    const after: Workflow = {
      ...base,
      nodes: [...base.nodes, asNode(node)],
      connections: sourceNode ? [{ id: 'c0', type: 'main', source: sourceNode.key, sourceIndex: step.output ?? 0, target: node.key, targetIndex: 0 }] : [],
    };
    const op = { op: 'addNode' as const, type: node.type, name: node.name, parameters: node.parameters ?? {} };
    const context = { latest: prompt, lookup };
    const empties = emptyParts({ nodes: [node], edges: [] }, byType).filter((p) => p.kind === 'empty');
    return [
      ...empties.map((p) => p.ask),
      // A list that is empty is said once, in the shape the node wants: not again as a wrong shape.
      ...validateNodeParameters(node.type, node.parameters ?? {}, lookup, node.name).filter((line) => !empties.some((e) => e.field && line.includes(`” ${e.field} `))),
      ...expressionMisses([op], base, after, context),
      ...cronProblems([op], base, after, context),
    ];
  };

  /** What a step's parameters look like once only the names the node has are kept, and an agent or team is a real one. */
  const keep = (info: NodeTypeInfo, parameters: Record<string, unknown>): Record<string, unknown> => {
    const known = new Set(info.descriptor.properties.map((p) => p.name));
    const kept = Object.fromEntries(Object.entries(parameters).filter(([k]) => known.has(k)));
    return info.type === 'core.runTeam' ? withTeamId(kept, teams) : info.type === 'core.messageAgent' ? knownAgent(withAgentId(kept, agents), agents) : kept;
  };

  /** One call, recorded: its size in characters (never its text), its time, the tokens the provider reported. */
  const call = async (step: PlanStep, messages: StepMessage[], stage: 'node' | 'send-back'): Promise<string> => {
    const budget = budgetLeft();
    if (budget <= 0) throw new Error('the build ran out of time (LANDFLOW_BUILDER_TIMEOUT_SECONDS)');
    const at = Date.now();
    calls++;
    const promptChars = system.length + messages.reduce((n, m) => n + m.content.length, 0);
    try {
      const answer = await ask(messages, budget, { stage, step: step.key });
      stages.push({ stage, step: step.key, inputTokens: answer.inputTokens ?? 0, outputTokens: answer.outputTokens ?? 0, promptChars, ms: Date.now() - at });
      return answer.text;
    } catch (e) {
      stages.push({ stage, step: step.key, inputTokens: 0, outputTokens: 0, promptChars, ms: Date.now() - at });
      throw e;
    }
  };

  const usedNames = new Set<string>();
  for (const step of plan.steps) {
    const info = byType.get(step.type);
    if (!info) {
      dropped.push(`node ${step.name} (${step.type})`);
      left.push({ node: step.name, kind: 'dropped', text: `“${step.name}”: the step type “${step.type}” is not available, so it was left out` });
      continue;
    }
    let name = step.name.slice(0, 60);
    for (let n = 2; usedNames.has(name.toLowerCase()); n++) name = `${step.name.slice(0, 56)} ${n}`;
    usedNames.add(name.toLowerCase());
    const node: DraftNode = { key: step.key, type: info.type, name, x: 0, y: 0, parameters: {} };
    const properties = info.descriptor.properties.filter((p) => p.type !== 'notice');
    // The test items go with the trigger's call, or, after a schedule (whose item is only a time), with the app step that reads data.
    const afterSchedule = triggerStep?.type === 'core.schedule' && step.from === triggerStep.key && info.pluginId !== 'core' && info.descriptor.kind === 'action';
    const wantsTestData = step === triggerStep ? pinsOnTrigger(step.type, triggerInfo) : afterSchedule;

    if (properties.length) {
      const roster =
        info.type === 'core.messageAgent' && agents.length ? `\n\nYour agents (put the agent's agentId in agentId, never its name):\n${describeAgents(agents)}`
        : info.type === 'core.runTeam' && teams.length ? `\n\nPublished agent teams (put the team's teamId in teamId, never its name):\n${describeTeams([...teams])}`
        : '';
      const testRule = wantsTestData
        ? `\n\nAlso write "testData": ${step === triggerStep ? (runsAgent ? '1 realistic sample item' : '2–4 realistic sample items') : '1 realistic sample item'} ${step === triggerStep ? 'the flow can be tested with' : 'of what this step puts out'} (objects with the fields the later steps read)${step.type === 'core.webhook' ? '; each item is what a call brings: {"body": {…}}, plus the "headers" or "query" a step reads' : ''}.`
        : '';
      const head = [`Request: ${prompt}`, `This step: “${name}” (${info.type}). What it does here: ${step.does}`, step.reads?.length ? `The plan says it reads: ${step.reads.map((r) => `$json.${r}`).join(', ')}.` : ''].filter(Boolean).join('\n');
      const tail = `\n\nWhat this step receives: ${receives(step)}${roster}${testRule}\n\nReply with {"parameters": {…}}${wantsTestData ? ' and "testData"' : ''}.`;
      // One call never sends more than the prompt budget: a node with a very long parameter list gets its docs cut.
      const room = PROMPT_TOKEN_BUDGET * 4 - system.length - head.length - tail.length - 600;
      const full = nodeDocs(info);
      const docs = full.length > room ? `${full.slice(0, Math.max(0, room))}\n…(the rest of the docs left out)` : full;
      const request = `${head}\n\nDocs of this step:\n${docs}${tail}`;

      const messages: StepMessage[] = [{ role: 'user', content: request }];
      let parameters: Record<string, unknown> = {};
      let testData: unknown[] | undefined;
      let problems: string[] = [];
      let failed: Error | undefined;
      let unusable = false;
      let text = '';
      const take = (reply: string): { parameters: Record<string, unknown>; testData?: unknown[]; problems: string[]; unusable?: boolean } => {
        const parsed = parseStep(reply, kit.jsonOf);
        if (!parsed.ok) return { parameters: {}, problems: [`${parsed.problem}; reply with one JSON object {"parameters": {…}}`], unusable: true };
        const kept = keep(info, parsed.parameters);
        return { parameters: kept, testData: parsed.testData, problems: checks(step, { ...node, parameters: kept }) };
      };
      try {
        text = await call(step, messages, 'node');
        ({ parameters, testData, problems, unusable = false } = take(text));
        succeeded++;
      } catch (e) {
        failed = e as Error;
        firstError ??= failed;
      }
      // Once, to this step alone, in the checks' own words; the second reply stands only when it is no worse.
      if (!failed && problems.length && budgetLeft() > 0) {
        try {
          const again = await call(step, [...messages, { role: 'assistant', content: text }, { role: 'user', content: `That reply has problems:\n${problems.map((p) => `- ${p}`).join('\n')}\nReply again with this step's whole {"parameters": {…}} as one JSON object, every problem above fixed as the request asks. Keep everything else as it is.` }], 'send-back');
          const next = take(again);
          if (next.problems.length <= problems.length) {
            ({ parameters, problems } = next);
            unusable = Boolean(next.unusable);
          }
          if (next.testData && !testData) testData = next.testData;
        } catch {
          // The first reply stands: a failed send-back is no reason to lose it.
        }
      }
      node.parameters = parameters;
      if (failed || unusable) left.push({ node: name, kind: 'empty', text: `“${name}”: its parameters could not be drafted (${clip(failed?.message ?? problems[0] ?? 'the reply was not usable', 120)}): fill it in` });
      else {
        const empties = emptyParts({ nodes: [node], edges: [] }, byType).filter((p) => p.kind === 'empty');
        for (const part of empties) left.push({ node: name, field: part.field, kind: 'empty', text: part.left });
        for (const problem of problems.filter((p) => !empties.some((e) => e.ask === p))) left.push({ node: name, kind: 'made-up', text: problem.startsWith('“') ? problem : `“${name}”: ${problem}` });
      }
      const items = asItems(testData);
      if (wantsTestData && items) testItems[step.key] = items;
    }
    nodes.push(node);

    // What the next steps receive from this one.
    const out: Output = { declared: outputFields(info.descriptor, withPropertyDefaults(info.descriptor.properties, node.parameters ?? {})) };
    if (TRIGGER_FIELDS[info.type]) out.sample = { ...TRIGGER_FIELDS[info.type] };
    if (AGENT_FIELDS[info.type]) out.sample = { ...AGENT_FIELDS[info.type] };
    if (info.type === 'core.set') {
      const upstream = node.parameters?.includeOtherFields !== false && step.from ? outputs.get(dataSource(step) ?? '') : undefined;
      const fields = Object.fromEntries(setNames(node.parameters ?? {}).map((n) => [n, '']));
      out.sample = { ...(upstream?.sample ?? {}), ...fields };
      if (!Object.keys(out.sample).length || (node.parameters?.includeOtherFields !== false && !upstream?.sample && !upstream?.declared)) out.sample = undefined;
    }
    if (step === triggerStep && testItems[step.key]) out.items = testItems[step.key];
    outputs.set(step.key, out);
  }

  // Every call failed (a model that is down): that is an error to say, not a draft of empty steps.
  if (calls > 0 && !succeeded && firstError) throw firstError;

  // The plan's wiring, exactly; an edge to a step that was left out goes with it and the step it fed is named.
  const kept = new Set(nodes.map((n) => n.key));
  const edges: Assembled['edges'] = [];
  for (const [source, target, output, type] of planEdges(plan)) {
    if (kept.has(source) && kept.has(target)) edges.push([source, target, output, type as ConnectionType]);
    else if (kept.has(target) && type === 'main') left.push({ node: nodes.find((n) => n.key === target)!.name, kind: 'dropped', text: `“${nodes.find((n) => n.key === target)!.name}”: the step before it was left out, so it is not connected: connect it` });
  }
  const trigger = nodes.find((n) => n.key === triggerStep?.key);
  return { nodes, edges, dropped, left, trigger, testItems, calls, stages, started };
}
