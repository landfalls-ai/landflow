/**
 * The Spotlight scenario suite's API: what a scenario is, what running it gives, and the checks the scorecards count.
 *
 * Contract file: backbone/contracts/sb2/spotlight-scenario.ts (version 2, wave sb2), copied byte for byte to
 * apps/web/test/spotlight-scenarios/scenario.ts by SB10 (owner this wave: the harness) and by every sb2 package that
 * adds scenarios (SB07, SB08, SB09, SB11, SB12, SB19). Version 1 was backbone/contracts/sb1/spotlight-scenario.ts
 * (SB00); version 2 only adds optional fields and helpers, so every sb1 scenario still type-checks. Change it in the
 * contracts folder first. Types and pure helpers only: no server import, no I/O. SB00's runner
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
 * - `design`: POST /api/agents/design (Spotlight's newAgent); `architect`: POST /api/assistant/agent (the dialog).
 */
export type Via = 'build' | 'chat' | 'session' | 'design' | 'architect';

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
   * for a scenario that has no echo server) leaves `LANDFLOW_OUTBOUND_ALLOW` unset, so a run to 127.0.0.1 is refused by
   * the host as on a fresh install; `allowed` sets it to `127.0.0.1,localhost` and nothing wider. Before sb2 the live
   * form allowed loopback whenever an echo server ran, so a blocked scenario was never blocked live.
   */
  outbound?: 'blocked' | 'allowed';
  /**
   * Wave sb2 (SB19): the model Spotlight is asked to use, as the picker sends it (`qwen3-coder:30b`,
   * `litellm/qwen3-coder:30b`). Absent: the harness's model (`LANDFLOW_SPOTLIGHT_MODEL`, else the unit form's script).
   * Live, only a model this machine serves: Ollama or the local LiteLLM container routing to it.
   */
  model?: string;
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
  /** Agents that exist after it, made by this scenario. */
  agents: Array<{ name: string; model?: string; tools: string[]; knowledge: boolean; published: boolean }>;
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

/** The checks several packages count; a package adds its own `Check`s beside them. */
export const checks = {
  /** Nothing tried to leave the machine, and nothing was refused for trying. */
  noOutside: { id: 'no-outside', label: 'Sent nothing outside this machine', judge: (o: Outcome) => o.refused.length === 0 } satisfies Check,
  /** A question: no change card, the canvas unchanged. */
  noChange: { id: 'no-change', label: 'Changed nothing', judge: (o: Outcome) => o.proposals.length === 0 && touchedNodes(o.before, o.after).length === 0 } satisfies Check,
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
};
