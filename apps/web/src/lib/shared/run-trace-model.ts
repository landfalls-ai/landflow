/**
 * Run Trace model: folds an execution's journal (lib/shared/run-trace.ts) into what the screens show: the span tree,
 * who took part, who called whom, how often, what each request delivered, who is working now, what needs a person,
 * and what was reported against what was checked. Pure, so the Run report node can use it too.
 * `until` folds only the events up to a time (the time slider replays a run with it).
 */
import { toolInput, type JournalEvent, type RunActor, type RunArtifact, type RunCheck, type SpanKind, type SpanStatus, type TokenCounts } from './run-trace';

/** What a request to another agent came to, from evidence (what it delivered), not from what the agent said. */
export type ResultLabel = 'Delivered' | 'Answered' | 'Left undelivered' | 'Working' | 'Waiting';
export type ResultTone = 'ok' | 'bad' | 'warn' | '';

export interface RunArtifactItem {
  id: string;
  seq: number;
  at: string;
  /** The span it was made in. */
  spanId: string;
  /** Who made it: the actor of that span. */
  actor?: RunActor;
  artifact: RunArtifact;
}

export interface RunCheckItem {
  id: string;
  seq: number;
  at: string;
  /** When a person or a gate settled it (`check.resolution`). */
  settledAt?: string;
  spanId: string;
  actor?: RunActor;
  check: RunCheck;
}

export interface RunSpan {
  id: string;
  parentId?: string;
  kind: SpanKind;
  name: string;
  actor: RunActor;
  caller?: RunActor;
  nodeId?: string;
  status: SpanStatus;
  state?: string;
  note?: string;
  startedAt: string;
  endedAt?: string;
  /** Start and end in ms; an open span ends at the time of the fold. */
  t0: number;
  t1: number;
  ms: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  usage?: TokenCounts;
  attrs: Record<string, unknown>;
  hidden: boolean;
  depth: number;
  children: string[];
  /** Words a member said between its tool calls during this request (inline messages), in order. */
  said: Array<{ seq: number; at: string; text: string }>;
  /** Made in this span itself. */
  artifacts: RunArtifactItem[];
  checks: RunCheckItem[];
  /** Made in this span or anything below it. */
  delivered: RunArtifactItem[];
  /** Tool calls below it, and how many of them failed (a request's remote steps). */
  steps: number;
  failedSteps: number;
  seq: number;
}

export interface RunActorStats {
  actor: RunActor;
  firstAt: string;
  /** Time in the spans it worked on (agent, request, step, wait), ms. */
  workMs: number;
  tokensIn: number;
  tokensOut: number;
  modelCalls: number;
  toolCalls: number;
  /** Requests addressed to it, and what they came to. */
  asked: number;
  results: ResultLabel[];
  /** Requests it made to others. */
  calls: number;
  messages: number;
  steps: number;
  failedSteps: number;
  waits: number;
  waitsAnswered: number;
  artifacts: RunArtifactItem[];
  failedChecks: RunCheckItem[];
}

/** Who called whom, over requests (delegate), handoffs, waits for a person. */
export interface RunEdge {
  from: string;
  to: string;
  delegate: number;
  handoff: number;
  wait: number;
  /** An agent node of the flow started by the flow itself: shown as a line without a counter. */
  started: number;
  first: string;
}

/** Two actors that asked each other more than once, or back and forth. */
export interface RunCycle {
  a: string;
  b: string;
  /** How often a asked b, b asked a. */
  ab: number;
  ba: number;
  /** Back-and-forth rounds: a→b→a→b… counted as pairs of a request and a request back. */
  rounds: number;
}

/**
 * One go round a flow that loops: the top-level steps from one start of the looping node to the next, and, after the
 * first, why the work went back (the Run report's failed checks or a person's note).
 */
export interface RunRound {
  n: number;
  key: string;
  /** The span the round starts with (the looping node's run). */
  spanId: string;
  startedAt: string;
  t0: number;
  t1: number;
  ms: number;
  seq: number;
  /** The flow's top-level spans in this round. */
  spanIds: string[];
  status: SpanStatus;
  why?: { text: string; failed: Array<{ name: string; message?: string }>; by?: string; spanId: string };
}

/** One thing a turn did or got back: a request to another agent, a tool call, words said between tool calls. */
export interface RunTurnItem {
  type: 'delegate' | 'tool' | 'said';
  key: string;
  spanId: string;
  at: string;
  seq: number;
  /** Who was asked, or the tool and what it worked on. */
  label: string;
  target?: RunActor;
  /** Why it was asked (the `reason` argument). */
  reason?: string;
  /** What was said, or what came back (the reply, the tool's result, the error). */
  text?: string;
  status: SpanStatus;
  ms: number;
  steps: number;
  failedSteps: number;
}

/**
 * One turn of an agent: for an agent with a model, one model call and what it asked for; for a member that works on
 * requests, one request (why it was asked, what it did, what came back).
 */
export interface RunTurn {
  key: string;
  /** 1, 2, 3… for this actor. */
  n: number;
  kind: 'think' | 'request';
  /** The model call, or the request. */
  spanId: string;
  at: string;
  seq: number;
  ms: number;
  status: SpanStatus;
  /** The round of the flow it happened in (when the flow loops). */
  round?: number;
  /** Why: the agent's words before acting, else what it wrote as the reason of each request; a request's `reason`. */
  reason?: string;
  /** Who asked (a request turn). */
  caller?: RunActor;
  /** A model turn with no calls: what the agent answered. */
  answer?: string;
  did: RunTurnItem[];
  /** A request turn: what came back to the caller. */
  back?: { text?: string; error?: string; ms: number; steps: number; failedSteps: number; result: ResultLabel; tone: ResultTone };
  tokens?: TokenCounts;
}

export interface RunWorking {
  spanId: string;
  actor: RunActor;
  name: string;
  kind: SpanKind;
  since: string;
  note?: string;
}

export type NeedsYouItem =
  | {
      kind: 'wait';
      spanId: string;
      actor: RunActor;
      caller?: RunActor;
      title: string;
      detail?: string;
      since: string;
      attrs: Record<string, unknown>;
    }
  | {
      kind: 'check';
      spanId: string;
      actor?: RunActor;
      title: string;
      detail?: string;
      since: string;
      check: RunCheckItem;
    };

export interface FailedStep {
  spanId: string;
  name: string;
  error?: string;
  at: string;
  actor: RunActor;
  /** The span above it ended well: the failure would not show in its status. */
  hidden: boolean;
}

export interface RunOutcome {
  /** What the run says it did: the last agent reply, else the last output. */
  reported?: { text: string; by: string; spanId: string };
  checked: {
    pass: number;
    fail: number;
    warn: number;
    skip: number;
    total: number;
    label: string;
    tone: ResultTone;
  };
}

export type StoryEntry =
  | {
      type: 'msg';
      key: string;
      at: string;
      seq: number;
      from: RunActor;
      to?: RunActor;
      text: string;
      spanId: string;
    }
  | { type: 'round'; key: string; at: string; seq: number; round: RunRound }
  | { type: 'agent'; key: string; at: string; seq: number; span: RunSpan }
  | { type: 'ask'; key: string; at: string; seq: number; span: RunSpan }
  | {
      type: 'reply';
      key: string;
      at: string;
      seq: number;
      span: RunSpan;
      result: [ResultLabel, ResultTone];
    }
  | { type: 'wait'; key: string; at: string; seq: number; span: RunSpan }
  | {
      type: 'steps';
      key: string;
      at: string;
      seq: number;
      spans: RunSpan[];
      failed: number;
    }
  | { type: 'stepfail'; key: string; at: string; seq: number; span: RunSpan }
  | {
      type: 'artifact';
      key: string;
      at: string;
      seq: number;
      item: RunArtifactItem;
    }
  | { type: 'check'; key: string; at: string; seq: number; item: RunCheckItem };

export interface RunModel {
  executionId?: string;
  /** No `run` span yet (an empty journal). */
  empty: boolean;
  status: SpanStatus;
  startedAt?: string;
  endedAt?: string;
  /** The time of the fold: `until`, else `now`, else the last event. */
  foldedAt: number;
  t0: number;
  /** The run's end when it has ended, else the time of the fold. */
  t1: number;
  live: boolean;
  lastSeq: number;
  lastAt?: string;
  spans: Record<string, RunSpan>;
  /** All spans, in the order they started. */
  order: RunSpan[];
  run?: RunSpan;
  actors: RunActorStats[];
  edges: RunEdge[];
  cycles: RunCycle[];
  working: RunWorking[];
  needsYou: NeedsYouItem[];
  failedSteps: FailedStep[];
  artifacts: RunArtifactItem[];
  checks: RunCheckItem[];
  messages: Extract<StoryEntry, { type: 'msg' }>[];
  /** Rounds of a flow that loops (two or more), else none. */
  rounds: RunRound[];
  /** Each agent's turns, by actor id. */
  turns: Record<string, RunTurn[]>;
  outcome: RunOutcome;
  tokens: TokenCounts;
  story: StoryEntry[];
}

const OPEN = (s: SpanStatus) => s === 'running' || s === 'waiting';
const REQUESTS = new Set<SpanKind>(['delegate', 'handoff']);
const WORK_KINDS = new Set<SpanKind>(['agent', 'delegate', 'handoff', 'step', 'wait']);
const QUIET_KINDS = new Set<SpanKind>(['step', 'tool', 'model']);

/** One line of anything: strings as is, an object by its text-like field, else short JSON. */
export function textOf(value: unknown, max = 400): string {
  let out = '';
  if (value == null) return '';
  if (typeof value === 'string') out = value;
  else if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['text', 'reply', 'message', 'question', 'prompt', 'result', 'content', 'summary']) {
      if (typeof o[key] === 'string' && o[key]) {
        out = o[key] as string;
        break;
      }
    }
    if (!out) {
      try {
        out = JSON.stringify(value);
      } catch {
        out = String(value);
      }
    }
  } else out = String(value);
  return cut(out, max);
}

export function cut(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What someone wrote, as a one-line preview reads it: Markdown's marks dropped (a heading becomes "Heading:"). */
export function preview(text: string, max: number): string {
  const plain = text
    .replace(/```[\w-]*/g, '')
    // A heading on its own line reads "Heading:"; one run into the text (a reply sent as one line) just loses its marks.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*:?[ \t]*\n/gm, '$1: ')
    .replace(/(^|\s)#{1,6}[ \t]+/g, '$1')
    .replace(/^[ \t]*[-*+][ \t]+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`\n]+)`/g, '$1')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1');
  return cut(plain, max);
}

const ms = (iso?: string): number => {
  const n = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(n) ? n : 0;
};

/** The result label of a request to another agent (and of a wait), as of the fold. */
export function resultOf(span: RunSpan): [ResultLabel, ResultTone] {
  if (span.status === 'waiting' || span.state === 'input-required') return OPEN(span.status) ? ['Waiting', 'warn'] : ['Answered', ''];
  if (span.status === 'running') return span.kind === 'wait' ? ['Waiting', 'warn'] : ['Working', 'warn'];
  if (span.kind === 'wait') return span.status === 'success' ? ['Answered', ''] : ['Left undelivered', 'bad'];
  if (span.status === 'error' || span.status === 'canceled') return ['Left undelivered', 'bad'];
  if (span.delivered.length) return ['Delivered', 'ok'];
  if (textOf(span.output)) return ['Answered', ''];
  return ['Left undelivered', 'bad'];
}

function checkKey(spanId: string, name: string) {
  return `${spanId}\u0000${name}`;
}

export function foldJournal(events: JournalEvent[], options: { until?: string | number; now?: number } = {}): RunModel {
  const until = options.until === undefined ? Infinity : typeof options.until === 'number' ? options.until : ms(options.until);
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const spans: Record<string, RunSpan> = {};
  const order: RunSpan[] = [];
  const artifacts: RunArtifactItem[] = [];
  const checkMap = new Map<string, RunCheckItem>();
  const messages: Extract<StoryEntry, { type: 'msg' }>[] = [];
  const actorBase = new Map<string, { actor: RunActor; firstAt: string }>();
  let executionId: string | undefined;
  let lastSeq = 0;
  let lastAt: string | undefined;
  let seen = -1;

  const note = (actor: RunActor, at: string) => {
    const known = actorBase.get(actor.id);
    if (!known) actorBase.set(actor.id, { actor: { ...actor }, firstAt: at });
    else {
      // Later events may know more (a role, the card name of a remote agent).
      known.actor = {
        ...known.actor,
        ...Object.fromEntries(Object.entries(actor).filter(([, v]) => v !== undefined && v !== '')),
      } as RunActor;
    }
  };
  const spanFor = (id: string) => spans[id] ?? spans.run;

  for (const event of sorted) {
    if (event.seq === seen) continue;
    seen = event.seq;
    if (ms(event.at) > until) continue;
    executionId ??= event.executionId;
    lastSeq = event.seq;
    lastAt = event.at;
    switch (event.type) {
      case 'span.started': {
        const existing = spans[event.spanId];
        const parentId =
          event.spanId === 'run' ? undefined : event.parentSpanId && spans[event.parentSpanId] ? event.parentSpanId : spans.run ? 'run' : undefined;
        const attrs = event.attrs ?? {};
        const span: RunSpan = {
          id: event.spanId,
          parentId,
          kind: event.kind,
          name: event.name,
          actor: event.actor,
          caller: event.caller,
          nodeId: event.nodeId,
          status: existing?.status ?? 'running',
          startedAt: event.at,
          t0: ms(event.at),
          t1: 0,
          ms: 0,
          input: event.kind === 'tool' ? toolInput(event.input) : event.input,
          attrs: { ...existing?.attrs, ...attrs },
          hidden: attrs.hidden === true,
          depth: 0,
          children: existing?.children ?? [],
          artifacts: existing?.artifacts ?? [],
          checks: existing?.checks ?? [],
          delivered: [],
          said: existing?.said ?? [],
          steps: 0,
          failedSteps: 0,
          seq: event.seq,
        };
        if (!existing) order.push(span);
        else order[order.indexOf(existing)] = span;
        spans[span.id] = span;
        if (parentId && !spans[parentId].children.includes(span.id)) spans[parentId].children.push(span.id);
        note(event.actor, event.at);
        if (event.caller) note(event.caller, event.at);
        break;
      }
      case 'span.updated': {
        const span = spans[event.spanId];
        if (!span) break;
        if (event.status) span.status = event.status;
        if (event.state !== undefined) span.state = event.state;
        if (event.note !== undefined) span.note = event.note;
        if (event.attrs) {
          Object.assign(span.attrs, event.attrs);
          if (event.attrs.hidden === true) span.hidden = true;
          // A remote agent's card name replaces the node's name once it is known.
          if (typeof event.attrs.agent === 'string' && event.attrs.agent) {
            span.actor = { ...span.actor, name: event.attrs.agent };
            note(span.actor, event.at);
          }
        }
        break;
      }
      case 'span.ended': {
        const span = spans[event.spanId];
        if (!span) break;
        span.status = event.status;
        span.endedAt = event.at;
        if (event.output !== undefined) span.output = event.output;
        if (event.error !== undefined) span.error = event.error;
        if (event.usage) span.usage = event.usage;
        if (event.attrs) Object.assign(span.attrs, event.attrs);
        break;
      }
      case 'message': {
        note(event.from, event.at);
        if (event.to) note(event.to, event.at);
        if (event.inline) {
          // Words between a member's tool calls belong to its request, not to the story.
          spans[event.spanId]?.said.push({ seq: event.seq, at: event.at, text: event.text });
          break;
        }
        messages.push({
          type: 'msg',
          key: `m:${event.seq}`,
          at: event.at,
          seq: event.seq,
          from: event.from,
          to: event.to,
          text: event.text,
          spanId: event.spanId,
        });
        break;
      }
      case 'artifact': {
        const span = spanFor(event.spanId);
        const item: RunArtifactItem = {
          id: `a:${event.seq}`,
          seq: event.seq,
          at: event.at,
          spanId: span?.id ?? event.spanId,
          actor: span?.actor,
          artifact: event.artifact,
        };
        artifacts.push(item);
        span?.artifacts.push(item);
        break;
      }
      case 'check': {
        const span = spanFor(event.spanId);
        const key = checkKey(event.spanId, event.check.name);
        const previous = checkMap.get(key);
        // A person's decision comes as a later event on the same check: it settles that check, it is not a second one.
        const item: RunCheckItem = {
          id: previous?.id ?? `c:${event.seq}`,
          seq: previous?.seq ?? event.seq,
          at: previous?.at ?? event.at,
          ...(event.check.resolution ? { settledAt: event.at } : previous?.settledAt && { settledAt: previous.settledAt }),
          spanId: span?.id ?? event.spanId,
          actor: span?.actor,
          check: previous ? { ...previous.check, ...event.check } : event.check,
        };
        checkMap.set(key, item);
        break;
      }
    }
  }

  // The fold's own clock.
  const foldedAt = Number.isFinite(until) ? until : (options.now ?? ms(lastAt));
  const run = spans.run;
  const ended = Boolean(run && !OPEN(run.status) && run.endedAt);
  const t0 = run?.t0 ?? 0;

  // Depth, durations, step counts.
  const visit = (span: RunSpan, depth: number) => {
    span.depth = depth;
    for (const id of span.children) visit(spans[id], depth + 1);
  };
  if (run) visit(run, 0);
  for (const span of order) {
    span.t1 = span.endedAt ? ms(span.endedAt) : Math.max(span.t0, foldedAt);
    span.ms = Math.max(0, span.t1 - span.t0);
  }
  // Checks attach to their span once settled.
  const checks = [...checkMap.values()].sort((a, b) => a.seq - b.seq);
  for (const item of checks) spans[item.spanId]?.checks.push(item);
  // What a span delivered: its own artifacts and those of anything below it.
  for (const item of artifacts) {
    for (let s: RunSpan | undefined = spans[item.spanId]; s; s = s.parentId ? spans[s.parentId] : undefined) s.delivered.push(item);
  }
  // Tool calls below a span.
  for (const span of order) {
    if (span.kind !== 'tool') continue;
    for (let s = span.parentId ? spans[span.parentId] : undefined; s; s = s.parentId ? spans[s.parentId] : undefined) {
      s.steps++;
      if (span.status === 'error') s.failedSteps++;
    }
  }

  // Actors and what each did.
  const stats = new Map<string, RunActorStats>();
  const statOf = (actor: RunActor, at: string): RunActorStats => {
    const base = actorBase.get(actor.id);
    let s = stats.get(actor.id);
    if (!s) {
      s = {
        actor: base?.actor ?? actor,
        firstAt: base?.firstAt ?? at,
        workMs: 0,
        tokensIn: 0,
        tokensOut: 0,
        modelCalls: 0,
        toolCalls: 0,
        asked: 0,
        results: [],
        calls: 0,
        messages: 0,
        steps: 0,
        failedSteps: 0,
        waits: 0,
        waitsAnswered: 0,
        artifacts: [],
        failedChecks: [],
      };
      stats.set(actor.id, s);
    }
    return s;
  };
  const edges = new Map<string, RunEdge>();
  const asks: Array<{ from: string; to: string; t: number }> = [];
  let tokensIn = 0;
  let tokensOut = 0;
  // Tokens come from every span that reports usage: a model call, an agent or team node (its own model's calls, its
  // members'), a remote agent's answer. A span keeps what the spans with usage nearest under it don't account for, so
  // nothing counts twice and each actor keeps its own.
  const own = new Map<string, TokenCounts>();
  for (const span of order) {
    if (!span.usage) continue;
    own.set(span.id, own.get(span.id) ?? { inputTokens: 0, outputTokens: 0 });
    const mine = own.get(span.id)!;
    mine.inputTokens += span.usage.inputTokens;
    mine.outputTokens += span.usage.outputTokens;
    for (let up = span.parentId ? spans[span.parentId] : undefined; up; up = up.parentId ? spans[up.parentId] : undefined) {
      if (!up.usage) continue;
      const theirs = own.get(up.id) ?? { inputTokens: 0, outputTokens: 0 };
      own.set(up.id, { inputTokens: theirs.inputTokens - span.usage.inputTokens, outputTokens: theirs.outputTokens - span.usage.outputTokens });
      break;
    }
  }
  const countTokens = (span: RunSpan, owner: RunActorStats) => {
    const used = own.get(span.id);
    if (!used) return;
    const input = Math.max(0, used.inputTokens);
    const output = Math.max(0, used.outputTokens);
    owner.tokensIn += input;
    owner.tokensOut += output;
    tokensIn += input;
    tokensOut += output;
  };
  for (const span of order) {
    const at = span.startedAt;
    if (span.kind === 'model') {
      // The model's tokens count for the agent that called it.
      const owner = statOf(span.caller ?? (span.parentId ? spans[span.parentId]?.actor : undefined) ?? span.actor, at);
      owner.modelCalls++;
      countTokens(span, owner);
      continue;
    }
    const mine = statOf(span.actor, at);
    countTokens(span, mine);
    if (span.kind === 'tool') mine.toolCalls++;
    if (WORK_KINDS.has(span.kind)) mine.workMs += span.ms;
    if (span.kind === 'wait') {
      mine.waits++;
      if (!OPEN(span.status)) mine.waitsAnswered++;
    }
    if (REQUESTS.has(span.kind)) {
      mine.asked++;
      mine.results.push(resultOf(span)[0]);
      mine.steps += span.steps;
      mine.failedSteps += span.failedSteps;
    }
    const caller = span.caller ?? (span.parentId ? spans[span.parentId]?.actor : undefined);
    if (REQUESTS.has(span.kind) || span.kind === 'wait') {
      if (caller && caller.id !== span.actor.id) {
        statOf(caller, at);
        if (REQUESTS.has(span.kind)) statOf(caller, at).calls++;
      }
    }
    if (caller && caller.id !== span.actor.id && (REQUESTS.has(span.kind) || span.kind === 'wait' || span.kind === 'agent')) {
      const key = `${caller.id}\u0000${span.actor.id}`;
      const edge = edges.get(key) ?? {
        from: caller.id,
        to: span.actor.id,
        delegate: 0,
        handoff: 0,
        wait: 0,
        started: 0,
        first: at,
      };
      if (span.kind === 'delegate') edge.delegate++;
      else if (span.kind === 'handoff') edge.handoff++;
      else if (span.kind === 'wait') edge.wait++;
      else edge.started++;
      edges.set(key, edge);
      if (REQUESTS.has(span.kind)) asks.push({ from: caller.id, to: span.actor.id, t: span.t0 });
    }
  }
  for (const m of messages) statOf(m.from, m.at).messages++;
  for (const item of artifacts) if (item.actor) statOf(item.actor, item.at).artifacts.push(item);
  for (const item of checks) if (item.actor && item.check.status === 'fail') statOf(item.actor, item.at).failedChecks.push(item);
  for (const entry of actorBase.values()) statOf(entry.actor, entry.firstAt);
  for (const s of stats.values()) s.actor = actorBase.get(s.actor.id)?.actor ?? s.actor;

  // Cycles: pairs that asked each other more than once, or back and forth.
  const cycles: RunCycle[] = [];
  const pairs = new Set<string>();
  for (const a of asks) pairs.add([a.from, a.to].sort().join('\u0000'));
  for (const pair of pairs) {
    const [a, b] = pair.split('\u0000');
    const ab = asks.filter((x) => x.from === a && x.to === b).length;
    const ba = asks.filter((x) => x.from === b && x.to === a).length;
    const rounds = Math.min(ab, ba);
    if (ab + ba > 1) cycles.push({ a, b, ab, ba, rounds });
  }

  // Who is working: the deepest open spans (nothing open below them).
  const working: RunWorking[] = [];
  if (!ended) {
    for (const span of order) {
      if (span.id === 'run' || span.hidden || span.kind === 'wait' || !OPEN(span.status)) continue;
      if (span.children.some((id) => OPEN(spans[id].status) && !spans[id].hidden && spans[id].kind !== 'wait')) continue;
      working.push({
        spanId: span.id,
        actor: span.actor,
        name: span.name,
        kind: span.kind,
        since: span.startedAt,
        note: span.note,
      });
    }
  }

  // Needs a person: open waits, failed checks nobody settled.
  const needsYou: NeedsYouItem[] = [];
  for (const span of order) {
    if (span.kind !== 'wait' || !OPEN(span.status)) continue;
    needsYou.push({
      kind: 'wait',
      spanId: span.id,
      actor: span.actor,
      caller: span.caller,
      title: span.name,
      detail: textOf(span.input) || undefined,
      since: span.startedAt,
      attrs: span.attrs,
    });
  }
  for (const item of checks) {
    if (item.check.status !== 'fail' || item.check.resolution) continue;
    needsYou.push({
      kind: 'check',
      spanId: item.spanId,
      actor: item.actor,
      title: item.check.name,
      detail: item.check.message,
      since: item.at,
      check: item,
    });
  }

  // Failed steps, also where the span above them ended well.
  const failedSteps: FailedStep[] = [];
  for (const span of order) {
    if (span.status !== 'error' || (span.kind !== 'tool' && span.kind !== 'step')) continue;
    const parent = span.parentId ? spans[span.parentId] : undefined;
    failedSteps.push({
      spanId: span.id,
      name: span.name,
      error: span.error,
      at: span.endedAt ?? span.startedAt,
      actor: span.actor,
      hidden: Boolean(parent && parent.status === 'success'),
    });
  }

  // Reported against checked.
  let reported: RunOutcome['reported'];
  let reportedEnd = -1;
  for (const span of order) {
    if (span.kind !== 'agent' || span.status !== 'success' || !span.endedAt) continue;
    const text = textOf(span.output, 2000);
    if (text && span.t1 >= reportedEnd) {
      reported = { text, by: span.actor.name, spanId: span.id };
      reportedEnd = span.t1;
    }
  }
  if (!reported && run && run.status === 'success') {
    const text = textOf(run.output, 2000);
    if (text) reported = { text, by: run.actor.name, spanId: run.id };
  }
  const count = { pass: 0, fail: 0, warn: 0, skip: 0 };
  for (const item of checks) count[item.check.status]++;
  const total = checks.length;
  const unsettled = checks.filter((c) => c.check.status === 'fail' && !c.check.resolution).length;
  const label = !total
    ? 'No checks ran'
    : count.fail
      ? `${count.fail} of ${total} failed${count.fail - unsettled > 0 ? `, ${count.fail - unsettled} settled` : ''}`
      : count.warn
        ? `${count.pass} passed, ${count.warn} to look at`
        : `All ${total} passed`;
  const tone: ResultTone = !total ? '' : unsettled ? 'bad' : count.fail || count.warn ? 'warn' : 'ok';

  const model: RunModel = {
    executionId,
    empty: !run,
    status: run?.status ?? 'running',
    startedAt: run?.startedAt,
    endedAt: ended ? run?.endedAt : undefined,
    foldedAt,
    t0,
    t1: ended && run ? run.t1 : Math.max(t0, foldedAt),
    live: Boolean(run && !ended && run.status === 'running'),
    lastSeq,
    lastAt,
    spans,
    order,
    run,
    actors: [...stats.values()],
    edges: [...edges.values()],
    cycles,
    working,
    needsYou,
    failedSteps,
    artifacts,
    checks,
    messages,
    rounds: [],
    turns: {},
    outcome: { reported, checked: { ...count, total, label, tone } },
    tokens: { inputTokens: tokensIn, outputTokens: tokensOut },
    story: [],
  };
  model.rounds = roundsOf(model);
  model.turns = turnsOf(model);
  model.story = storyOf(model);
  return model;
}

/** The steps of the flow itself (not what happens inside an agent): the top-level spans. */
const flowSpans = (model: RunModel) => model.order.filter((s) => s.parentId === 'run' && (s.kind === 'agent' || s.kind === 'step') && !s.hidden);

/**
 * Rounds of a flow that loops: the node that ran again (the first to start, not counting a run that went on after a wait)
 * begins each round; what ran before its first start belongs to round 1. Why the work went back is what the Run report
 * before the next round said (its send-back text and failed checks, or a person's note).
 */
export function roundsOf(model: RunModel): RunRound[] {
  const top = flowSpans(model);
  const fresh = top.filter((s) => s.attrs.resumed !== true && s.nodeId);
  const runs = new Map<string, RunSpan[]>();
  for (const s of fresh) runs.set(s.nodeId!, [...(runs.get(s.nodeId!) ?? []), s]);
  const anchor = fresh.find((s) => (runs.get(s.nodeId!)?.length ?? 0) > 1);
  if (!anchor) return [];
  const starts = runs.get(anchor.nodeId!)!;
  const rounds: RunRound[] = starts.map((start, index) => {
    const end = starts[index + 1]?.seq ?? Infinity;
    const members = top.filter((s) => (index === 0 || s.seq >= start.seq) && s.seq < end);
    const t1 = members.reduce((latest, s) => Math.max(latest, s.t1), start.t1);
    const open = members.some((s) => OPEN(s.status));
    const failed = members.some((s) => s.status === 'error');
    return {
      n: index + 1,
      key: `round:${index + 1}`,
      spanId: start.id,
      startedAt: start.startedAt,
      t0: start.t0,
      t1,
      ms: Math.max(0, t1 - start.t0),
      seq: start.seq,
      spanIds: members.map((s) => s.id),
      status: open ? 'running' : failed ? 'error' : 'success',
    };
  });
  for (let i = 1; i < rounds.length; i++) {
    const report = [...rounds[i - 1].spanIds].reverse().map((id) => model.spans[id]).find((s) => s.attrs.nodeType === 'core.runReport' && s.output && typeof s.output === 'object');
    if (!report) continue;
    const out = report.output as Record<string, unknown>;
    const failed = (Array.isArray(out.checks) ? out.checks : [])
      .filter((c): c is Record<string, unknown> => Boolean(c) && typeof c === 'object' && (c as Record<string, unknown>).status === 'fail')
      .map((c) => ({ name: String(c.name ?? 'Check'), ...(typeof c.message === 'string' && c.message && { message: c.message }) }));
    const note = typeof out.note === 'string' ? out.note : '';
    const text = [typeof out.sendBack === 'string' ? out.sendBack : '', note].filter(Boolean).join('\n\n');
    if (!text && !failed.length) continue;
    rounds[i].why = { text, failed, ...(typeof out.decidedBy === 'string' && { by: out.decidedBy }), spanId: report.id };
  }
  return rounds.length > 1 ? rounds : [];
}

/** What a tool call worked on, as one short line: "Bash: pnpm typecheck". */
function toolLabel(span: RunSpan): string {
  const input = span.input && typeof span.input === 'object' ? (span.input as Record<string, unknown>) : undefined;
  const detail = typeof span.input === 'string' ? span.input : (['command', 'file_path', 'path', 'url', 'query'].map((k) => input?.[k]).find((v) => typeof v === 'string') as string | undefined);
  return cut(detail && !span.name.includes(detail) ? `${span.name}: ${detail}` : span.name, 90);
}

function itemOf(span: RunSpan): RunTurnItem {
  const back = span.error ?? (span.output !== undefined ? textOf(span.output, 600) : '');
  const reason = typeof span.attrs.reason === 'string' ? span.attrs.reason : undefined;
  const delegate = REQUESTS.has(span.kind);
  return {
    type: delegate ? 'delegate' : 'tool',
    key: `i:${span.id}`,
    spanId: span.id,
    at: span.startedAt,
    seq: span.seq,
    label: delegate ? span.actor.name : toolLabel(span),
    ...(delegate && { target: span.actor }),
    ...(reason && { reason }),
    ...(back && { text: back }),
    status: span.status,
    ms: span.ms,
    steps: span.steps,
    failedSteps: span.failedSteps,
  };
}

/**
 * Each agent's turns. An agent with a model: one turn per model call, with the requests and tool calls it made after it.
 * A member that is asked things: one turn per request, with why it was asked, what it did and said, what came back.
 */
export function turnsOf(model: RunModel): Record<string, RunTurn[]> {
  const out: Record<string, RunTurn[]> = {};
  const roundOf = (spanId: string) => model.rounds.find((r) => r.spanIds.includes(spanId))?.n;
  const push = (actorId: string, turn: Omit<RunTurn, 'n'>) => (out[actorId] ??= []).push({ ...turn, n: (out[actorId]?.length ?? 0) + 1 });
  for (const span of model.order) {
    if (span.kind === 'agent') {
      // The turns of one run of the agent: a model call starts a turn, what follows it (until the next call) is what it did.
      const round = roundOf(span.id);
      const turns: Array<{ call?: RunSpan; did: RunTurnItem[]; at: string; seq: number; t0: number }> = [];
      for (const kid of span.children.map((id) => model.spans[id])) {
        if (kid.kind === 'model') turns.push({ call: kid, did: [], at: kid.startedAt, seq: kid.seq, t0: kid.t0 });
        else if (!kid.hidden && (REQUESTS.has(kid.kind) || kid.kind === 'tool')) {
          if (!turns.length) turns.push({ did: [], at: kid.startedAt, seq: kid.seq, t0: kid.t0 });
          turns[turns.length - 1].did.push(itemOf(kid));
        }
      }
      turns.forEach((turn, index) => {
        const said = turn.call ? textOf((turn.call.output as Record<string, unknown> | undefined)?.text, 2000) : '';
        const asked = turn.did.map((d) => d.reason).filter(Boolean);
        push(span.actor.id, {
          key: `t:${turn.call?.id ?? span.id}`,
          kind: 'think',
          spanId: turn.call?.id ?? span.id,
          at: turn.at,
          seq: turn.seq,
          ms: Math.max(0, (turns[index + 1]?.t0 ?? span.t1) - turn.t0),
          status: turn.call?.status ?? span.status,
          ...(round && { round }),
          ...(turn.did.length ? (said || asked.length ? { reason: said || asked.join(' · ') } : {}) : said ? { answer: said } : {}),
          did: turn.did,
          ...(turn.call?.usage && { tokens: turn.call.usage }),
        });
      });
    } else if (REQUESTS.has(span.kind)) {
      const did: RunTurnItem[] = [
        ...span.children.map((id) => model.spans[id]).filter((k) => k.kind === 'tool' && !k.hidden).map(itemOf),
        ...span.said.map((words, index): RunTurnItem => ({ type: 'said', key: `w:${span.id}:${index}`, spanId: span.id, at: words.at, seq: words.seq, label: span.actor.name, text: words.text, status: 'success', ms: 0, steps: 0, failedSteps: 0 })),
      ].sort((a, b) => a.seq - b.seq);
      const reason = typeof span.attrs.reason === 'string' ? span.attrs.reason : undefined;
      const [result, tone] = resultOf(span);
      push(span.actor.id, {
        key: `t:${span.id}`,
        kind: 'request',
        spanId: span.id,
        at: span.startedAt,
        seq: span.seq,
        ms: span.ms,
        status: span.status,
        ...(roundOf(span.parentId ?? span.id) && { round: roundOf(span.parentId ?? span.id) }),
        ...(reason && { reason }),
        ...(span.caller && { caller: span.caller }),
        did,
        back: { ...(textOf(span.output, 600) && { text: textOf(span.output, 600) }), ...(span.error && { error: span.error }), ms: span.ms, steps: span.steps, failedSteps: span.failedSteps, result, tone },
        ...(span.usage && { tokens: span.usage }),
      });
    }
  }
  return out;
}

/** Whether a span sits inside a request to another agent (its steps show with that request, not on their own). */
function insideRequest(model: RunModel, span: RunSpan): boolean {
  for (let p = span.parentId ? model.spans[span.parentId] : undefined; p; p = p.parentId ? model.spans[p.parentId] : undefined) {
    if (REQUESTS.has(p.kind)) return true;
  }
  return false;
}

/** The chat-like story: messages, requests with their results, waits, artifacts, failures; quiet spans folded into "n steps". */
export function storyOf(model: RunModel): StoryEntry[] {
  const raw: StoryEntry[] = [];
  for (const m of model.messages) raw.push(m);
  for (const round of model.rounds) raw.push({ type: 'round', key: round.key, at: round.startedAt, seq: round.seq - 0.25, round });
  for (const span of model.order) {
    if (span.hidden || span.id === 'run') continue;
    const at = span.startedAt;
    if (span.kind === 'agent') {
      raw.push({ type: 'agent', key: `s:${span.id}`, at, seq: span.seq, span });
      if (span.endedAt && textOf(span.output))
        raw.push({
          type: 'reply',
          key: `r:${span.id}`,
          at: span.endedAt,
          seq: span.seq + 0.5,
          span,
          result: resultOf(span),
        });
    } else if (REQUESTS.has(span.kind)) {
      raw.push({ type: 'ask', key: `s:${span.id}`, at, seq: span.seq, span });
      if (span.endedAt)
        raw.push({
          type: 'reply',
          key: `r:${span.id}`,
          at: span.endedAt,
          seq: span.seq + 0.5,
          span,
          result: resultOf(span),
        });
    } else if (span.kind === 'wait') {
      raw.push({ type: 'wait', key: `s:${span.id}`, at, seq: span.seq, span });
    } else if (QUIET_KINDS.has(span.kind) && !insideRequest(model, span)) {
      if (span.status === 'error')
        raw.push({
          type: 'stepfail',
          key: `f:${span.id}`,
          at: span.endedAt ?? at,
          seq: span.seq,
          span,
        });
      else
        raw.push({
          type: 'steps',
          key: `g:${span.id}`,
          at,
          seq: span.seq,
          spans: [span],
          failed: 0,
        });
    }
  }
  for (const item of model.artifacts)
    raw.push({
      type: 'artifact',
      key: item.id,
      at: item.at,
      seq: item.seq,
      item,
    });
  for (const item of model.checks)
    if (item.check.status === 'fail' || item.check.status === 'warn')
      raw.push({
        type: 'check',
        key: item.id,
        at: item.at,
        seq: item.seq,
        item,
      });
  raw.sort((a, b) => ms(a.at) - ms(b.at) || a.seq - b.seq);
  // Neighbouring quiet spans become one row.
  const out: StoryEntry[] = [];
  for (const entry of raw) {
    const last = out[out.length - 1];
    if (entry.type === 'steps' && last?.type === 'steps') {
      last.spans.push(...entry.spans);
      continue;
    }
    out.push(entry.type === 'steps' ? { ...entry, spans: [...entry.spans] } : entry);
  }
  return out;
}

/** Names the two ends of an edge. */
export function edgeParts(edge: RunEdge): string[] {
  const parts: string[] = [];
  if (edge.delegate) parts.push(`asked ×${edge.delegate}`);
  if (edge.handoff) parts.push(`handed off ×${edge.handoff}`);
  if (edge.wait) parts.push(`waited ×${edge.wait}`);
  return parts;
}

/** Quiet time: ms since the last event while the run is live (the silence watchdog). */
export function quietMs(model: RunModel, now: number): number {
  if (!model.live || !model.lastAt) return 0;
  return Math.max(0, now - ms(model.lastAt));
}

/** A readable length of time: "420 ms", "8.4 s", "3m 05s". */
export function fmtMs(value: number): string {
  const v = Math.max(0, value);
  if (v < 1000) return `${Math.round(v)} ms`;
  const s = v / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)} s`;
  let m = Math.floor(s / 60);
  let r = Math.round(s % 60);
  if (r === 60) {
    m += 1;
    r = 0;
  }
  if (m >= 60) return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `${m}m ${String(r).padStart(2, '0')}s`;
}
