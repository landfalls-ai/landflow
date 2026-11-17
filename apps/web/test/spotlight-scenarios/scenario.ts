/**
 * The Spotlight scenario suite's API: what a scenario is, what running it gives, and the checks the scorecards count.
 *
 * Contract file: backbone/contracts/ag2/spotlight-scenario.ts (version 5, wave ag2), copied byte for byte to
 * apps/web/test/spotlight-scenarios/scenario.ts by AG08 (owner this wave; no other ag2 package copies it: AG07's and AG09's
 * scenario files use version 4's fields only). Version 4 was backbone/contracts/ag1/spotlight-scenario.ts (AG02), version 3
 * backbone/contracts/sb3/spotlight-scenario.ts (SB13), version 2 backbone/contracts/sb2/spotlight-scenario.ts (SB10),
 * version 1 backbone/contracts/sb1/spotlight-scenario.ts (SB00); each version only adds optional fields and helpers, so
 * every earlier scenario still type-checks. Wave ag1's and ag2's scenario files are named `sb-ag0N.ts` (ag2: sb-ag07,
 * sb-ag08, sb-ag09; the runner globs `sb*.ts`; nobody changes the glob) with `owner: 'AG0N'`. Change it in the contracts folder first. Types and pure helpers only: no server import, no I/O. SB00's runner
 * (apps/web/test/spotlight-scenarios.test.ts, with apps/web/test/spotlight-scenarios/harness.ts) finds every
 * `apps/web/test/spotlight-scenarios/<owner>.ts` (lower case, e.g. `sb03.ts`) with `import.meta.glob`, so packages never
 * edit a shared index: each adds one file that `export default defineScenarios([...])`.
 *
 * Two forms of one scenario: the unit form (always run) answers with `script`, a scripted model, and every check must
 * hold; the live form (only with LANDFLOW_INTEGRATION=spotlight) asks the local model (qwen3-coder:30b on Ollama by
 * default) `live.runs` times and the checks are counted into the scorecard. A scenario without `script` is live only.
 */
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { AssistantOp, RunDigest } from '@/lib/shared/assistant-ops';

/** The three jobs of the evaluation (spotlight-pro/findings.md): build from scratch, fix one step, create agents. */
export type Job = 'build' | 'fix' | 'agent';

/**
 * How the harness drives it, through the product's own code (the route handler where one exists, as the synthetic owner
 * of apps/web/test/setup.ts, so allowed types, the roster and AI usage apply):
 * - `build`: POST /api/ai/build (the empty canvas's first draft);
 * - `chat`: POST /api/assistant/chat, then the proposals applied with the product's `applyOps`;
 * - `session`: a chat as above, then Spotlight's test-and-fix session on the result (the editor stores in Node, runs
 *   from `start.runs` in the unit form, real in-process runs in the live form);
 * - `design`: POST /api/agents/design (Spotlight's newAgent); `architect`: POST /api/assistant/agent (the dialog);
 * - `agent-ask` (wave sb3, SB16): what the editor does with a typed "create an agent …": `agentAsk` on the message, POST
 *   /api/agents/design with `preview: true` (the card), then the card's Create (POST /api/agents/import and the cases),
 *   on an empty `start.workflow` (or none) the starter flow as `after`, and with `start.autonomy: 'auto'` also SB18's
 *   smoke test on the starter flow's sample item and the publish that follows a pass.
 * - `agent-revise` (wave ag1, AG04): a change to an agent in words. With `start.card`, that ask is designed first as
 *   `agent-ask` does (the pending card, not created), then `ask` is the follow-up typed under it: the card is revised in
 *   place (POST /api/agents/design with `preview: true`, `base: { config }` and `change`), nothing created. With
 *   `start.agent`, that config is imported (and published) first, then `ask` is typed on its page: the change card
 *   (`base: { agentId }`), then Apply (`PUT /api/agents/:id`, the draft only; never a publish).
 */
export type Via = 'build' | 'chat' | 'session' | 'design' | 'architect' | 'agent-ask' | 'agent-revise';

/** One model reply in the unit form; a function sees what the model was asked. */
export type ScriptTurn = Partial<ModelTurn> | ((input: Parameters<LanguageModel['generate']>[0]) => Partial<ModelTurn>);

/** One scripted run of the session's unit form: each node by name, with its error or how many items it put out. */
export type ScriptedRun = Record<string, { error?: string; items?: number }>;

export interface Start {
  /** The canvas before the ask; absent or empty for a build. */
  workflow?: Workflow;
  /** The selected node, by name. */
  selected?: string;
  /** The last run of each node, by node name (what the editor sends as `runs`). */
  runs?: Record<string, RunDigest>;
  /** What Spotlight may do alone (contracts/sb1/spotlight-autonomy.ts); default 'asks-first'. */
  autonomy?: 'auto' | 'asks-first';
  /** A test-and-fix session's request instead of a typed message. */
  session?: 'fix' | 'review' | 'auto';
  /** `session` via, unit form: the runs the session sees, in order (one per round). */
  sessionRuns?: ScriptedRun[];
  /** The person's yes to test runs that send for real, by destination host (none by default). */
  approvedDestinations?: string[];
  /**
   * Wave sb2 (SB07): the scope the editor sends, by node NAME (the harness maps names to ids for the body's `scope`):
   * absent, the editor sent none and the server derives one (lib/shared/spotlight-scope.ts `scopeOf`); `null`, the
   * person lifted the chip.
   */
  scope?: { kind: 'selected' | 'tagged' | 'only' | 'insert'; nodes: string[]; side?: 'after' | 'before' } | null;
  /** Wave sb2 (SB07): steps the person tagged with @, by name (sent as the editor's node mentions). */
  tagged?: string[];
  /**
   * Wave sb2 (SB10, carryover item 5): the host's outbound policy for the session's live runs. `blocked` (the default
   * for a scenario that has no echo server) runs with `LANDFLOW_OUTBOUND_BLOCK_PRIVATE=true` and no `LANDFLOW_OUTBOUND_ALLOW`, so a run to 127.0.0.1 is refused by
   * the host as production refuses it; `allowed` sets it to `127.0.0.1,localhost` and nothing wider. Before sb2 the live
   * form allowed loopback whenever an echo server ran, so a blocked scenario was never blocked live.
   */
  outbound?: 'blocked' | 'allowed';
  /**
   * Wave sb2 (SB19): the model Spotlight is asked to use, as the picker sends it (`qwen3-coder:30b`,
   * `litellm/qwen3-coder:30b`). Absent: the harness's model (`LANDFLOW_SPOTLIGHT_MODEL`, else the unit form's script).
   * Live, only a model this machine serves: Ollama or the local LiteLLM container routing to it.
   */
  model?: string;
  /**
   * Wave sb3 (SB13): the `build` via plans first, as the editor does from sb3 on: POST /api/ai/build/plan, then POST
   * /api/ai/build with that plan. Absent: the live form plans first and the unit form posts the prompt alone (the base's
   * one-shot draft, so sb1's and sb2's scripts still hold) until the integrator migrates those scripts at the merge
   * (carryover-sb3.md §1) and makes planning the default for both forms. `false`: never plans (the one-shot fallback).
   */
  staged?: boolean;
  /**
   * Wave sb3 (SB14): a plan given outright (a `BuildPlan`, lib/shared/build-plan.ts, as JSON), posted with the prompt to
   * POST /api/ai/build so stage 2 is measured on its own; the plan route is not called. Kept untyped here so a package
   * that does not copy build-plan.ts still compiles this file.
   */
  plan?: Record<string, unknown>;
  /** Wave ag1 (AG04): for `agent-revise`, the earlier ask whose card is still pending when `ask` is typed under it. */
  card?: string;
  /** Wave ag1 (AG04): for `agent-revise`, an existing agent's config (`POST /api/agents/import`, then published) whose page `ask` is typed on. */
  agent?: Record<string, unknown>;
  /**
   * Wave ag1 (AG02): the local plugins the scenario needs by plugin id (`triage`, `grafana`, `text-toolkit`, `databases`,
   * `go-crypto`, `py-insights`, `messaging`). Unit form: the harness registers stand-ins from the recorded manifests (or
   * the TypeScript plugin's own code in-process); live form: the TypeScript ones in-process, the Go and Python ones from
   * `LANDFLOW_SPOTLIGHT_PLUGINS` endpoints, and a scenario whose plugin is in neither is skipped with the reason.
   */
  plugins?: string[];
}

/** What running a scenario once gave. Every list is empty, never absent. */
export interface Outcome {
  scenario: string;
  form: 'unit' | 'live';
  ms: number;
  /** The reply as the person reads it (the build's summary for a build). */
  text: string;
  /** Tool names in the order called (search_nodes, get_run_data, propose_changes, ask_user …). */
  tools: string[];
  proposals: Array<{ summary: string; ops: AssistantOp[]; dropped: string[]; warnings: string[] }>;
  /** The canvas before and after (proposals applied; for a build, the draft as a workflow). */
  before?: Workflow;
  after?: Workflow;
  /** A build's `FlowDraft` as the route answered it. */
  draft?: Record<string, unknown>;
  /** The "Needs you" rows a session showed (`Need.what`, contracts/sb1/needs-you.md), in order. */
  needs: string[];
  /** Destinations the run tried to reach (host:port) and the ones the local-only guard refused. */
  sent: string[];
  refused: string[];
  /**
   * Agents that exist after it, made by this scenario. Wave sb3 adds optional fields (read them with `?? []` / `?? 0`):
   * `toolsDetail` (SB17: each tool's node type, operation and whether it needs approval), `cases` (SB17: test cases
   * saved for the eval gate), `practices` (SB17: approved practices in its prompt), `guardrails` (SB17: in words).
   */
  agents: Array<{
    name: string;
    model?: string;
    tools: string[];
    knowledge: boolean;
    published: boolean;
    toolsDetail?: Array<{ name: string; type?: string; operation?: string; requireApproval: boolean }>;
    cases?: number;
    practices?: boolean;
    guardrails?: string[];
    /** Wave ag1 (AG02): the description and the instructions as saved (or as the card's config holds them). */
    description?: string;
    instructions?: string;
    /** Wave ag2 (AG08): each test case's input, as saved for the eval gate (or as the card holds them), in order. */
    caseInputs?: string[];
    /** Wave ag2 (AG08): each node tool's parameters as the design set them, by tool name (read with `?? {}`). */
    toolParameters?: Record<string, Record<string, unknown>>;
  }>;
  /** Model calls, and tokens in and out as AI usage recorded them. */
  modelCalls: number;
  tokens: { input: number; output: number };
  /** The reply's error (an `error` event or a thrown error), if any. */
  error?: string;
  /**
   * Wave sb2 (SB11): the questions the chat asked back (`ask` events, lib/shared/spotlight-wire.ts), in order. Optional
   * (unlike the lists above) so a package's copy of this file type-checks against a harness that does not fill it yet;
   * read it as `o.asked ?? []`.
   */
  asked?: Array<{ question: string; choices: string[] }>;
  /** Wave sb2 (SB12): the credentials it offered to pick (`credential` events), in order: the step and the types it accepts (`o.offers ?? []`). */
  offers?: Array<{ node: string; credentialTypes: string[] }>;
  /** Wave sb2 (SB19): the model the reply's `done` event named (or the build's `model`), when there was one. */
  model?: string;
  /**
   * SB10: in a session, all or nothing: every proposal when the session left the store's canvas untouched (the guard
   * refused them, or they wait for Apply), otherwise unset. `checks.noChange` subtracts it, so a session that only showed
   * cards reads "changed nothing".
   */
  unapplied?: number;
  /** Wave sb3 (SB13): a build's plan as the draft reports it (`draft.plan`): each step's name and node type in order (the trigger first), and what no node could do. */
  plan?: { steps: Array<{ name: string; type: string }>; cannot: string[] };
  /** Wave sb3 (SB13): a build's model calls in order (`draft.stages`): the stage and the prompt's size in tokens (the greater of the reported and the estimated count). */
  prompts?: Array<{ stage: string; tokens: number }>;
  /**
   * Wave sb3 (SB16): an agent card was shown (`agent-ask`), and whether the starter flow came with it. Wave ag1 adds, as
   * the card shows them: `model` and `models` (AG02: the Model row and its select), `notAdded` (AG02: the tools asked for
   * and not added, by name) and `changes` (AG04: a revised card's lines).
   */
  card?: { starter: boolean; model?: string; models?: string[]; notAdded?: string[]; changes?: string[]; needs?: string[] /* ag2 (AG08): the card's Left row, in order */ };
  /** Wave sb3 (SB18): the smoke test of the agent it made, as the row reads it (lib/shared/agent-card.ts `AgentSmoke.state`). */
  smoke?: 'passed' | 'failed' | 'untested';
  /** Wave ag1 (AG05): the smoke test's reason, and each tool call's status (`AgentSmokeTool`), when there was one. */
  smokeReason?: string;
  smokeTools?: Array<{ name: string; status: 'success' | 'error' | 'empty' | 'denied' }>;
  /** Wave ag1 (AG02): the host's builder model as the server names it (`LANDFLOW_BUILDER_MODEL`, `provider/model` or a bare Ollama name). */
  hostModel?: string;
  /** Wave ag1: what each node tool's call handed the node as its input item (`inputs[0][0].json`), in call order. AG02's stand-ins record it; AG03's `item` argument is what fills it. */
  toolInputs?: Array<{ tool: string; input: Record<string, unknown> }>;
  /** Wave ag1 (AG04): an `agent-revise` on an existing agent: whether Apply saved its draft, and whether anything published it. */
  revised?: { agentId: string; savedDraft: boolean; published: boolean };
}

/** A check: true, false, or 'n/a' (it does not apply to this outcome; not counted). */
export interface Check {
  /** Stable id: the scorecard's row ("collections-filled", "only-asked-node", "no-outside"). */
  id: string;
  label: string;
  judge: (outcome: Outcome) => boolean | 'n/a';
}

export interface Scenario {
  /** Unique: `<owner>-<slug>` in lower case, e.g. `sb04-why-last-run`. */
  id: string;
  /** The package that added it: 'SB00' … 'SB06' (later waves continue the numbering). */
  owner: string;
  job: Job;
  via: Via;
  title: string;
  /** What the person typed (or, for an agent, what Spotlight's newAgent asked for). */
  ask: string;
  start?: Start;
  /** Unit form: the scripted model's replies, in order. Absent: live only. */
  script?: ScriptTurn[];
  checks: Check[];
  /** Live form: how many runs (default 3), or why it is skipped live. */
  live?: { runs?: number; skip?: string };
}

/** A scenario file's default export. */
export function defineScenarios(list: Scenario[]): Scenario[] {
  return list;
}

/** A LanguageModel that answers from `turns` and records what it was asked; it throws when the script runs out. */
export function scriptedModel(turns: ScriptTurn[]): { model: LanguageModel; calls: Array<Parameters<LanguageModel['generate']>[0]> } {
  const left = [...turns];
  const calls: Array<Parameters<LanguageModel['generate']>[0]> = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      calls.push({ ...input, messages: [...input.messages] });
      const next = left.shift();
      if (!next) throw new Error('No scripted turn left');
      const turn = typeof next === 'function' ? next(input) : next;
      return { text: '', toolCalls: [], stopReason: 'stop', ...turn };
    },
  };
  return { model, calls };
}

/** A scripted tool call, for `script`: `call('propose_changes', { summary, ops })`. */
export function call(name: string, input: Record<string, unknown>, text = ''): Partial<ModelTurn> {
  return { text, toolCalls: [{ id: `call_${name}_${Math.random().toString(36).slice(2, 8)}`, name, input }], stopReason: 'tool_use' };
}

/** Node names whose type, parameters, settings or wiring differ between before and after (added and removed too). */
export function touchedNodes(before: Workflow | undefined, after: Workflow | undefined): string[] {
  if (!before || !after) return [];
  const key = (wf: Workflow, id: string) => {
    const node = wf.nodes.find((n) => n.id === id);
    const wires = wf.connections.filter((c) => c.source === id || c.target === id).map((c) => `${c.source}>${c.target}:${c.sourceIndex}:${c.type}`).sort();
    return JSON.stringify([node, wires]);
  };
  const ids = new Set([...before.nodes.map((n) => n.id), ...after.nodes.map((n) => n.id)]);
  const name = (id: string) => after.nodes.find((n) => n.id === id)?.name ?? before.nodes.find((n) => n.id === id)?.name ?? id;
  return [...ids].filter((id) => key(before, id) !== key(after, id)).map(name);
}

/** Wave ag1: a name as a tool's call name and a person's word compare (lower case, every run of other characters one `_`). */
export function toolKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

/** The checks several packages count; a package adds its own `Check`s beside them. */
export const checks = {
  /** Nothing tried to leave the machine, and nothing was refused for trying. */
  noOutside: { id: 'no-outside', label: 'Sent nothing outside this machine', judge: (o: Outcome) => o.refused.length === 0 } satisfies Check,
  /** A question: no change card, the canvas unchanged. */
  noChange: { id: 'no-change', label: 'Changed nothing', judge: (o: Outcome) => o.proposals.length - (o.unapplied ?? 0) === 0 && touchedNodes(o.before, o.after).length === 0 } satisfies Check,
  /** At least one change card. */
  proposed: { id: 'proposed', label: 'Showed a change card', judge: (o: Outcome) => o.proposals.length > 0 } satisfies Check,
  /** The reply has words and no error. */
  answered: { id: 'answered', label: 'Answered in words', judge: (o: Outcome) => !o.error && o.text.trim().length > 0 } satisfies Check,
  /** Only these nodes changed (by name). */
  onlyTouches: (names: string[]): Check => ({
    id: 'only-asked-node',
    label: `Changed only ${names.join(', ')}`,
    judge: (o) => (o.after ? touchedNodes(o.before, o.after).every((n) => names.includes(n)) : 'n/a'),
  }),
  /** The session asked the person for this "Needs you" reason. */
  needs: (what: string): Check => ({ id: `needs-${what}`, label: `Asked the person (${what})`, judge: (o) => o.needs.includes(what) }),
  /** Wave sb2 (SB11): asked one question back, with 2–4 choices, and changed nothing yet. */
  askedFirst: {
    id: 'asked-first',
    label: 'Asked which one, changed nothing yet',
    judge: (o: Outcome) => (o.asked ?? []).length > 0 && (o.asked ?? []).every((a) => a.choices.length >= 2 && a.choices.length <= 4) && o.proposals.length === 0 && touchedNodes(o.before, o.after).length === 0,
  } satisfies Check,
  /** Wave sb2 (SB12): the reply has words, never an empty bubble (finding 2.7). */
  neverEmpty: { id: 'never-empty', label: 'Said something (no empty reply)', judge: (o: Outcome) => Boolean(o.error) || o.text.trim().length > 0 } satisfies Check,
  /** Wave sb2 (SB12): offered a credential for this step, and set none itself (decision D2). */
  offeredCredential: (node: string): Check => ({
    id: 'offered-credential',
    label: `Offered a credential to pick for ${node}, set none`,
    judge: (o) => {
      const count = (wf: Workflow | undefined) => Object.keys(wf?.nodes.find((n) => n.name === node)?.credentials ?? {}).length;
      return (o.offers ?? []).some((c) => c.node === node) && count(o.after) <= count(o.before);
    },
  }),
  /** Wave sb3 (SB13): every model call of the build sent at most `tokens` (6000 by the plan); 'n/a' when no call was reported. */
  promptUnder: (tokens: number): Check => ({
    id: 'prompt-under',
    label: `Every prompt under ${tokens} tokens`,
    judge: (o) => (o.prompts?.length ? o.prompts.every((p) => p.tokens <= tokens) : 'n/a'),
  }),
  /** Wave sb3 (SB13): the plan has exactly one trigger, and it is the first step. */
  oneTrigger: {
    id: 'one-trigger',
    label: 'Planned one trigger',
    judge: (o: Outcome) => {
      const trigger = (type: string) => /manualTrigger|webhook|schedule|chatTrigger|Trigger$/.test(type);
      return o.plan ? o.plan.steps.filter((s) => trigger(s.type)).length === 1 && trigger(o.plan.steps[0]?.type ?? '') : 'n/a';
    },
  } satisfies Check,
  /** Wave sb3 (SB16): an agent card, and on an empty canvas the starter flow with a Run an Agent step pointing at the new agent. */
  agentCard: (starter: boolean): Check => ({
    id: starter ? 'card-and-starter' : 'agent-card',
    label: starter ? 'Agent card and a starter flow that runs it' : 'Agent card',
    judge: (o) => {
      if (!o.card) return false;
      if (!starter) return true;
      const step = o.after?.nodes.find((n) => n.type === 'core.messageAgent');
      return o.card.starter && Boolean(o.after?.nodes.some((n) => n.type === 'core.chatTrigger')) && typeof step?.parameters?.agentId === 'string' && step.parameters.agentId !== '';
    },
  }),
  /** Wave ag1 (AG02): every agent it made runs on the host's builder model (finding 2); 'n/a' when the harness named none. */
  modelFollowsHost: {
    id: 'model-follows-host',
    label: 'The agent runs on the host’s builder model',
    judge: (o: Outcome) => {
      if (!o.hostModel || !o.agents.length) return 'n/a';
      const bare = (m: string) => m.replace(/^(ollama|anthropic|openai)\//, '');
      return o.agents.every((a) => Boolean(a.model) && bare(String(a.model)) === bare(o.hostModel!));
    },
  } satisfies Check,
  /** Wave ag1 (AG02): the instructions name no tool the agent does not have (finding 3): every snake_case word is one of its tools. */
  toolsNamedReal: {
    id: 'tools-named-real',
    label: 'Instructions name only its own tools',
    judge: (o: Outcome) => {
      const agent = o.agents[0];
      if (!agent?.instructions) return 'n/a';
      const own = new Set(agent.tools.map(toolKey));
      const named = agent.instructions.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [];
      return named.every((n) => own.has(n));
    },
  } satisfies Check,
  /** Wave ag1 (AG02): the person's text is kept as given (finding 4: "oncall@landflow.test", not "oncall@landflow"). */
  keepsText: (text: string): Check => ({
    id: 'keeps-text',
    label: `Kept “${text}” as given`,
    judge: (o) => {
      const agent = o.agents[0];
      if (!agent) return false;
      const words = `${agent.description ?? ''}\n${agent.instructions ?? ''}`;
      return new RegExp(`${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`).test(words);
    },
  }),
  /** Wave ag1 (AG02): each tool the ask named is on the agent or in the card's "Not added" line, never silently dropped (finding 9). */
  askedToolsAccounted: (names: string[]): Check => ({
    id: 'asked-tools-accounted',
    label: `Added or said why not: ${names.join(', ')}`,
    judge: (o) => {
      const agent = o.agents[0];
      if (!agent) return false;
      const have = [...agent.tools, ...(agent.toolsDetail ?? []).map((t) => t.type ?? '')].map(toolKey);
      const said = (o.card?.notAdded ?? []).map(toolKey);
      return names.every((n) => have.some((h) => h.includes(toolKey(n))) || said.some((s) => s.includes(toolKey(n))));
    },
  }),
  /** Wave ag1 (AG02): a read (`select`, `get`, `getAll`, `list`, `search`) asks for no approval (finding 12); 'n/a' without details. */
  readsWithoutApproval: {
    id: 'reads-without-approval',
    label: 'Reads need no approval',
    judge: (o: Outcome) => {
      const detail = o.agents.flatMap((a) => a.toolsDetail ?? []);
      const reads = detail.filter((t) => t.operation && /^(select|get|getAll|getMany|list|search|read)$/i.test(t.operation));
      return reads.length ? reads.every((t) => !t.requireApproval) : 'n/a';
    },
  } satisfies Check,
  /** Wave ag1 (AG04): a change to an existing agent was saved as its draft and published by nothing (D3: only after its smoke test and the gate). */
  revisedNotPublished: {
    id: 'revised-not-published',
    label: 'The change was saved as a draft, not published',
    judge: (o: Outcome) => (o.revised ? o.revised.savedDraft && !o.revised.published : 'n/a'),
  } satisfies Check,
  /**
   * Wave ag2 (AG08): every test case is an input a person would send (the alert itself), never a description of one ("Pasted
   * alert about high CPU"), a `<placeholder>` or a line under 12 characters; 'n/a' when the harness read no case inputs.
   */
  caseInputsReal: {
    id: 'case-inputs-real',
    label: 'Test cases are real inputs, not descriptions',
    judge: (o: Outcome) => {
      const inputs = o.agents.flatMap((a) => a.caseInputs ?? []);
      if (!inputs.length) return 'n/a';
      return inputs.every((input) => !describesInput(input));
    },
  } satisfies Check,
  /**
   * Wave ag2 (AG08): every destination parameter of every node tool (To, CC, BCC, URL, channel, chat id, path, repository)
   * is empty, or a value `ask` holds word for word (lesson 21: never a destination nobody gave); 'n/a' without parameters.
   */
  destinationsGiven: (ask: string): Check => ({
    id: 'destinations-given',
    label: 'Destinations only from the ask',
    judge: (o) => {
      const all = o.agents.flatMap((a) => Object.values(a.toolParameters ?? {}));
      if (!all.length) return 'n/a';
      return all.every((parameters) =>
        Object.entries(parameters).every(([key, value]) => {
          if (!DESTINATION.test(key) || value === undefined || value === null || value === '') return true;
          return typeof value === 'string' && ask.toLowerCase().includes(value.trim().toLowerCase());
        }),
      );
    },
  }),
};

/** Wave ag2 (AG08): the parameter names that say where a tool sends or reads (checked by `destinationsGiven`). */
export const DESTINATION = /^(?:to|cc|bcc|toEmail|ccEmail|bccEmail|recipients?|url|baseUrl|endpoint|endpointUrl|webhookUrl|channel|channelId|chatId|path|filePath|repository|owner|repo)$/i;

/**
 * Wave ag2 (AG08): a test case's input that describes an input instead of being one: a `<placeholder>`, under 12
 * characters, a line that starts like a description of a thing ("Pasted Grafana alert about high CPU on web-01", "An email
 * from a customer", "Random text that is not an alert") or of a person sending it ("A user asks how to reset their
 * password"), unless it then holds the thing itself after a colon ("An alert from Wazuh: [Wazuh] rule 5710 …").
 */
export function describesInput(input: string): boolean {
  const text = input.trim();
  if (text.length < 12 || /<[^<>\n]{1,40}>/.test(text)) return true;
  if (text.length >= 160 || /:\s*\S.{11,}/.test(text)) return false;
  const thing = /^(?:an?|the|some|another|pasted|random|sample|example|generic|typical|plain)\b[^:]{0,80}?\b(?:alert|e-?mail|message|text|log|ticket|request|question|input|payload|event|notification|report|string|token|jwt|file|data|record|row)s?\b(?:\s+(?:about|for|with|that|from|of|where|which|containing|saying|asking|describing|showing|on|in)\b|\s*$)/i;
  const person = /^(?:an?|the|some)\s+(?:user|customer|person|visitor|engineer|teammate|colleague|client)\s+(?:asks?|says|sends|wants|reports|writes|pastes|requests|needs)\b/i;
  return thing.test(text) || person.test(text);
}
