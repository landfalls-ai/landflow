/**
 * Comparing runs and measuring them over time (docs/run-trace.md, "Search, compare and measures"): a run's journal folded
 * (run-trace-model.ts) down to the numbers two runs are held against each other by, and the difference per actor.
 */
import type { RunModel } from './run-trace-model';
import type { ActorType } from './run-trace';

/** What one actor did in a run. */
export interface ActorDigest {
  id: string;
  name: string;
  type: ActorType;
  /** Tool and step spans it ran. */
  steps: number;
  failedSteps: number;
  modelCalls: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  workMs: number;
}

/** A run in numbers. */
export interface RunDigest {
  executionId: string;
  workflowId?: string;
  workflowName?: string;
  status: string;
  startedAt?: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /** USD of the usage that was priced; absent when none was. */
  costUsd?: number;
  modelCalls: number;
  steps: number;
  failedSteps: number;
  checks: { pass: number; fail: number; warn: number };
  /** Names of the checks that failed. */
  failedChecks: string[];
  artifacts: Array<{ name: string; kind?: string }>;
  actors: ActorDigest[];
}

/** The numbers of a folded journal. */
export function digestRun(model: RunModel, info: { executionId: string; workflowId?: string; workflowName?: string } = { executionId: model.executionId ?? '' }): RunDigest {
  const steps = new Map<string, number>();
  for (const span of model.order) {
    if ((span.kind === 'tool' || span.kind === 'step') && !span.hidden) steps.set(span.actor.id, (steps.get(span.actor.id) ?? 0) + 1);
  }
  const failed = new Map<string, number>();
  for (const item of model.failedSteps) failed.set(item.actor.id, (failed.get(item.actor.id) ?? 0) + 1);
  const actors: ActorDigest[] = model.actors.map((s) => ({
    id: s.actor.id,
    name: s.actor.name,
    type: s.actor.type,
    steps: steps.get(s.actor.id) ?? 0,
    failedSteps: failed.get(s.actor.id) ?? 0,
    modelCalls: s.modelCalls,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    costUsd: Math.round(s.costUsd * 1e6) / 1e6,
    workMs: Math.round(s.workMs),
  }));
  const checks = { pass: 0, fail: 0, warn: 0 };
  const failedChecks: string[] = [];
  for (const item of model.checks) {
    if (item.check.status === 'pass') checks.pass++;
    else if (item.check.status === 'fail') {
      checks.fail++;
      if (!failedChecks.includes(item.check.name)) failedChecks.push(item.check.name);
    } else if (item.check.status === 'warn') checks.warn++;
  }
  const run = model.run;
  return {
    ...info,
    status: model.status,
    ...(model.startedAt && { startedAt: model.startedAt }),
    durationMs: Math.round(run ? run.ms : model.t1 - model.t0),
    tokensIn: model.tokens.inputTokens,
    tokensOut: model.tokens.outputTokens,
    ...(model.tokens.costUsd !== undefined && { costUsd: model.tokens.costUsd }),
    modelCalls: actors.reduce((sum, a) => sum + a.modelCalls, 0),
    steps: actors.reduce((sum, a) => sum + a.steps, 0),
    failedSteps: model.failedSteps.length,
    checks,
    failedChecks,
    artifacts: model.artifacts.map((a) => ({ name: a.artifact.name, ...(a.artifact.kind && { kind: a.artifact.kind }) })),
    actors,
  };
}

/** How one actor differs between two runs; `a` or `b` is absent when the actor took part in only one. */
export interface ActorDiff {
  id: string;
  name: string;
  type: ActorType;
  a?: ActorDigest;
  b?: ActorDigest;
  /** b minus a (a missing side counts as nothing). */
  delta: { steps: number; failedSteps: number; modelCalls: number; tokensIn: number; tokensOut: number; costUsd: number; workMs: number };
}

export interface RunComparison {
  a: RunDigest;
  b: RunDigest;
  /** b minus a. */
  delta: { durationMs: number; tokensIn: number; tokensOut: number; costUsd?: number; modelCalls: number; steps: number; failedSteps: number; checksFailed: number; artifacts: number };
  actors: ActorDiff[];
}

const NONE: Omit<ActorDigest, 'id' | 'name' | 'type'> = { steps: 0, failedSteps: 0, modelCalls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0, workMs: 0 };
const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function compareRuns(a: RunDigest, b: RunDigest): RunComparison {
  const byId = (digest: RunDigest) => new Map(digest.actors.map((x) => [x.id, x]));
  const left = byId(a);
  const right = byId(b);
  const actors: ActorDiff[] = [...new Set([...left.keys(), ...right.keys()])].map((id) => {
    const x = left.get(id);
    const y = right.get(id);
    const base = (y ?? x)!;
    const from = x ?? NONE;
    const to = y ?? NONE;
    return {
      id,
      name: base.name,
      type: base.type,
      ...(x && { a: x }),
      ...(y && { b: y }),
      delta: { steps: to.steps - from.steps, failedSteps: to.failedSteps - from.failedSteps, modelCalls: to.modelCalls - from.modelCalls, tokensIn: to.tokensIn - from.tokensIn, tokensOut: to.tokensOut - from.tokensOut, costUsd: round(to.costUsd - from.costUsd), workMs: to.workMs - from.workMs },
    };
  });
  // The largest change first.
  actors.sort((p, q) => Math.abs(q.delta.tokensIn + q.delta.tokensOut) + Math.abs(q.delta.steps) - (Math.abs(p.delta.tokensIn + p.delta.tokensOut) + Math.abs(p.delta.steps)));
  return {
    a,
    b,
    delta: {
      durationMs: b.durationMs - a.durationMs,
      tokensIn: b.tokensIn - a.tokensIn,
      tokensOut: b.tokensOut - a.tokensOut,
      ...(a.costUsd !== undefined || b.costUsd !== undefined ? { costUsd: round((b.costUsd ?? 0) - (a.costUsd ?? 0)) } : {}),
      modelCalls: b.modelCalls - a.modelCalls,
      steps: b.steps - a.steps,
      failedSteps: b.failedSteps - a.failedSteps,
      checksFailed: b.checks.fail - a.checks.fail,
      artifacts: b.artifacts.length - a.artifacts.length,
    },
    actors,
  };
}

/** One run of a workflow as a point of its measures over time. */
export interface RunMeasure {
  executionId: string;
  startedAt: string;
  status: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  costUsd?: number;
  failedSteps: number;
  checksFailed: number;
}

export const measureOf = (digest: RunDigest): RunMeasure => ({
  executionId: digest.executionId,
  startedAt: digest.startedAt ?? '',
  status: digest.status,
  durationMs: digest.durationMs,
  tokensIn: digest.tokensIn,
  tokensOut: digest.tokensOut,
  ...(digest.costUsd !== undefined && { costUsd: digest.costUsd }),
  failedSteps: digest.failedSteps,
  checksFailed: digest.checks.fail,
});
