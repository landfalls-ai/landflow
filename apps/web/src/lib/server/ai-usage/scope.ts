/**
 * Usage scopes: which execution, workflow, agent and session a model call belongs to, and the caps it
 * must stay under. A scope is opened around an execution segment (runner) or an agent run (agents
 * runtime) with AsyncLocalStorage, so every model call made underneath, however deep (sub-nodes,
 * tools, sub-workflows, sub-agents), finds it. Scopes nest: a sub-workflow's scope has its caller's as
 * parent, so a call counts towards every scope above it and every cap on the way must allow it.
 *
 * telemetry/ai.ts calls `beforeModelCall` / `afterModelCall` around each `gen_ai.*` span. This file
 * keeps no database state: the meter (price table, rows, daily sums) is handed in by ./index.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { AiModelUsage, AiUsageTotals } from '../../shared/ai-usage';
import { singleton } from '../singleton';

export interface ModelCall {
  /** `gen_ai.system`: anthropic, openai, ollama… */
  provider: string;
  model: string;
  operation: 'chat' | 'embeddings';
  /** The model credential the call was made with (caps per credential); absent for the host's own keys and local models. */
  credentialId?: string;
}

export interface MeteredCall extends ModelCall {
  /** The whole prompt, cached tokens included. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
}

/** A limit one scope enforces, e.g. "200,000 tokens per day for this workflow". */
export interface UsageLimit {
  metric: 'tokens' | 'cost';
  max: number;
  /** For the error: "this execution", "this workflow today", "agent “Support” this month". */
  subject: string;
  /** Where to change it: "Workflow settings → AI usage limits". */
  setIn: string;
  /** What the subject used so far (including the call just made, once it is recorded). */
  used: () => number;
}

/** Prices calls and stores them; shared by a scope tree (children inherit their root's meter). */
export interface UsageMeter {
  cost(call: ModelCall & { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number;
  record(call: MeteredCall, scope: UsageScope): void;
  /** Caps that depend on the call itself (the credential it uses) or on who started the run (Settings → AI usage caps). */
  callLimits?(call: ModelCall, scope: UsageScope): UsageLimit[];
}

export interface UsageScopeInfo {
  executionId?: string;
  workflowId?: string;
  agentId?: string;
  sessionId?: string;
  /** Who started the run (a signed-in user), for the caps per user. */
  userId?: string;
  /** What made the call when no execution or agent did: Spotlight, the Agent architect or the brain (`ai_usage.surface`). */
  surface?: 'spotlight' | 'architect' | 'brain';
}

/** Thrown when a cap is reached: the call is refused (or, once over the cap, the run stops after it). */
export class UsageCapError extends Error {
  readonly limit: { metric: UsageLimit['metric']; max: number; used: number; subject: string };

  constructor(limit: UsageLimit, used: number) {
    const amount = (value: number) => (limit.metric === 'cost' ? `$${value.toFixed(value < 1 ? 4 : 2)}` : `${Math.round(value).toLocaleString('en-US')} tokens`);
    super(`AI usage cap reached: ${limit.subject} used ${amount(used)} of its ${amount(limit.max)} limit (${limit.setIn})`);
    this.name = 'UsageCapError';
    this.limit = { metric: limit.metric, max: limit.max, used, subject: limit.subject };
  }
}

/** True for a UsageCapError from any module graph (instanceof fails across Next.js bundles). */
export const isUsageCapError = (error: unknown): error is UsageCapError => (error as Error | undefined)?.name === 'UsageCapError';

const add = (totals: AiUsageTotals, call: MeteredCall) => {
  totals.inputTokens += call.inputTokens;
  totals.outputTokens += call.outputTokens;
  if (call.cacheReadTokens) totals.cacheReadTokens = (totals.cacheReadTokens ?? 0) + call.cacheReadTokens;
  if (call.cacheWriteTokens) totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + call.cacheWriteTokens;
  totals.cost += call.cost;
  totals.calls += 1;
};

export class UsageScope {
  /** Calls attributed to this scope as the nearest one with an execution (or, without one, the nearest scope). */
  readonly own: AiUsageTotals;
  /** Every call made under this scope, sub-workflows and sub-agents included. */
  readonly tree: AiUsageTotals;
  private readonly models = new Map<string, AiModelUsage>();

  constructor(
    readonly info: UsageScopeInfo,
    readonly limits: UsageLimit[] = [],
    readonly parent?: UsageScope,
    private readonly meterOverride?: UsageMeter,
    /** Totals of earlier segments of the same execution (a resumed run). */
    base?: { totals: AiUsageTotals; models?: AiModelUsage[] },
  ) {
    this.own = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0, ...base?.totals };
    this.tree = { ...this.own };
    for (const model of base?.models ?? []) this.models.set(`${model.provider}/${model.model}`, { ...model });
  }

  get meter(): UsageMeter | undefined {
    return this.meterOverride ?? this.parent?.meter;
  }

  /** The nearest value of `key` up the chain: a sub-agent's call still names the execution it ran in. */
  lookup<K extends keyof UsageScopeInfo>(key: K): UsageScopeInfo[K] {
    for (let scope: UsageScope | undefined = this; scope; scope = scope.parent) if (scope.info[key]) return scope.info[key];
    return undefined;
  }

  /** This scope and its ancestors, nearest first. */
  *chain(): Generator<UsageScope> {
    for (let scope: UsageScope | undefined = this; scope; scope = scope.parent) yield scope;
  }

  /** Per-model totals of `own`, biggest cost first. */
  modelTotals(): AiModelUsage[] {
    return [...this.models.values()].sort((a, b) => b.cost - a.cost || b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
  }

  /** Throw when any cap up the chain, or any cap that applies to this call (its credential, who started the run), is already reached. */
  check(when: 'before' | 'after', call?: ModelCall) {
    const reached = (limit: UsageLimit) => {
      if (!(limit.max > 0)) return;
      const used = limit.used();
      if (when === 'before' ? used >= limit.max : used > limit.max) throw new UsageCapError(limit, used);
    };
    for (const scope of this.chain()) for (const limit of scope.limits) reached(limit);
    if (call) for (const limit of this.meter?.callLimits?.(call, this) ?? []) reached(limit);
  }

  /** Count a finished call on the chain and hand it to the meter. */
  add(call: MeteredCall) {
    const owner = [...this.chain()].find((scope) => scope.info.executionId) ?? this;
    add(owner.own, call);
    const key = `${call.provider}/${call.model}`;
    const model = owner.models.get(key) ?? { provider: call.provider, model: call.model, inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
    add(model, call);
    owner.models.set(key, model);
    for (const scope of this.chain()) add(scope.tree, call);
    this.meter?.record(call, this);
  }
}

const storage = singleton('ai-usage-scope', () => new AsyncLocalStorage<UsageScope>());

/** The scope of the code running now, if any. */
export const currentUsageScope = (): UsageScope | undefined => storage.getStore();

/** Run `fn` inside `scope`. */
export function runInUsageScope<T>(scope: UsageScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** Before a model call: refuse it when a cap is reached. Outside any scope, nothing to check. */
export function beforeModelCall(call: ModelCall) {
  currentUsageScope()?.check('before', call);
}

/**
 * After a model call: price it, record it, and throw when it went over a cap (the run stops there with a
 * clear error; the call's result is lost, but it is counted). Returns the estimated cost.
 */
export function afterModelCall(call: ModelCall & { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number | undefined {
  const scope = currentUsageScope();
  const meter = scope?.meter;
  if (!scope || !meter) return undefined;
  const count = (value: number | undefined) => Math.max(0, Math.round(value ?? 0));
  const inputTokens = count(call.inputTokens);
  // The cached parts are parts of the prompt: never more than it.
  const cacheReadTokens = Math.min(count(call.cacheReadTokens), inputTokens);
  const cacheWriteTokens = Math.min(count(call.cacheWriteTokens), inputTokens - cacheReadTokens);
  const tokens = { inputTokens, outputTokens: count(call.outputTokens), cacheReadTokens, cacheWriteTokens };
  const metered: MeteredCall = { ...call, ...tokens, cost: meter.cost({ ...call, ...tokens }) };
  scope.add(metered);
  scope.check('after', call);
  return metered.cost;
}
