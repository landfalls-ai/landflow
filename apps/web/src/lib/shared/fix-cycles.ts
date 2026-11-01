/**
 * Fix cycles (docs/run-trace.md#fix-cycles): for each actor, the times it ran a check command (tests, typecheck, build,
 * lint) in order, whether each passed, how many errors it printed, and how much it changed in between — told as a trend:
 * "typecheck 19 → 13, never passed". Which commands are checks comes from the flow's run profile (its claims' evidence
 * patterns), so a flow without such claims has no fix cycles. A pure fold over the model.
 */
import { profilePattern, type RunProfile } from './run-profiles';
import type { RunModel, RunSpan } from './run-trace-model';
import type { RunActor } from './run-trace';

/** The profile claims that are checks a command runs. */
const CHECK_CLAIMS = new Set(['tests', 'test', 'typecheck', 'lint', 'build']);
/** What counts as a change to the work when the profile names none: an edit or a write. */
const DEFAULT_WORK = String.raw`^(Edit|Write|MultiEdit|NotebookEdit)\b`;

export interface FixRun {
  spanId: string;
  at: string;
  passed: boolean;
  /** Errors, failures or problems the output counts, when it says. */
  errors?: number;
  /** Changes made since the actor's previous run of this check (or since it began). */
  changes: number;
}

export interface FixCycle {
  actor: RunActor;
  /** The profile claim's id: `typecheck`, `tests`, `lint`, `build`. */
  check: string;
  label: string;
  runs: FixRun[];
  passed: boolean;
  /** "typecheck 19 → 13, never passed". */
  trend: string;
}

const text = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['result', 'content', 'output', 'stdout', 'text']) if (typeof o[key] === 'string') return o[key] as string;
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  return String(value);
};

/** What a step ran, as text to match a pattern against: its name and its input. */
function commandOf(span: RunSpan): string {
  const input = span.input && typeof span.input === 'object' ? (span.input as Record<string, unknown>) : undefined;
  const detail = typeof span.input === 'string' ? span.input : (['command', 'file_path', 'path', 'query'].map((k) => input?.[k]).find((v) => typeof v === 'string') as string | undefined);
  return `${span.name} ${detail ?? ''}`;
}

/** Whether a finished check step failed: it errored, its output says so (`isError`, an exit code) or counts errors. */
function failed(span: RunSpan, output: string): boolean {
  if (span.status === 'error') return true;
  const result = span.output && typeof span.output === 'object' ? (span.output as Record<string, unknown>) : undefined;
  if (result?.isError === true || (result?.output && typeof result.output === 'object' && (result.output as Record<string, unknown>).isError === true)) return true;
  return /\bExit code [1-9]\d*\b/.test(output) || /\berror TS\d+/.test(output);
}

/** The number of errors a check printed: tsc's `error TS…` lines or "Found N errors", "N failed" (test runners), "N problems" (linters). */
export function errorCount(output: string): number | undefined {
  const found = /\bFound (\d+) errors?\b/.exec(output);
  if (found) return Number(found[1]);
  const ts = output.match(/\berror TS\d+/g);
  if (ts) return ts.length;
  const runner = /\b(\d+) failed\b/.exec(output) ?? /\bFailed: (\d+)\b/.exec(output) ?? /\bTests:\s+(\d+) failed\b/.exec(output);
  if (runner) return Number(runner[1]);
  const go = output.match(/^--- FAIL/gm);
  if (go) return go.length;
  const lint = /\b(\d+) (?:problems?|errors?)\b/.exec(output);
  return lint ? Number(lint[1]) : undefined;
}

function trendOf(check: string, runs: FixRun[]): string {
  const steps = runs.map((run) => (run.passed ? 'passed' : run.errors !== undefined ? String(run.errors) : 'failed'));
  const last = runs[runs.length - 1];
  const everPassed = runs.some((run) => run.passed);
  return `${check} ${steps.join(' → ')}${last.passed ? '' : everPassed ? ', failing again' : ', never passed'}`;
}

/** Each actor's check runs, in order, for the checks the profile names. */
export function fixCyclesOf(model: RunModel, profile: RunProfile): FixCycle[] {
  const rules = (profile.claims ?? []).filter((claim) => CHECK_CLAIMS.has(claim.id)).flatMap((claim) => {
    const evidence = profilePattern(claim.evidence);
    return evidence ? [{ id: claim.id === 'test' ? 'tests' : claim.id, label: claim.label, evidence }] : [];
  });
  if (!rules.length) return [];
  const work = profilePattern(profile.deliveries?.[0]?.work) ?? profilePattern(DEFAULT_WORK)!;
  const steps = model.order.filter((s) => s.kind === 'tool' && !s.hidden).sort((a, b) => a.seq - b.seq);
  const cycles: FixCycle[] = [];
  for (const rule of rules) {
    const byActor = new Map<string, FixCycle>();
    const lastRun = new Map<string, number>();
    steps.forEach((step, index) => {
      const command = commandOf(step);
      // A check is run by a command, not by editing a file that happens to be called "typecheck".
      if (!rule.evidence.test(command) || work.test(command) || OPEN_STEP.has(step.status)) return;
      const output = `${step.error ?? ''}\n${text(step.output)}`;
      const bad = failed(step, output);
      const since = lastRun.get(step.actor.id) ?? -1;
      const changes = steps.slice(since + 1, index).filter((s) => s.actor.id === step.actor.id && work.test(commandOf(s)) && s.status !== 'error').length;
      lastRun.set(step.actor.id, index);
      const errors = bad ? errorCount(output) : undefined;
      let cycle = byActor.get(step.actor.id);
      if (!cycle) {
        cycle = { actor: step.actor, check: rule.id, label: rule.label, runs: [], passed: false, trend: '' };
        byActor.set(step.actor.id, cycle);
      }
      cycle.runs.push({ spanId: step.id, at: step.startedAt, passed: !bad, ...(errors !== undefined && { errors }), changes });
    });
    for (const cycle of byActor.values()) {
      cycle.passed = cycle.runs[cycle.runs.length - 1].passed;
      cycle.trend = trendOf(rule.id, cycle.runs);
      // One clean run is no cycle; a failure, even once, is one.
      if (cycle.runs.length > 1 || !cycle.passed) cycles.push(cycle);
    }
  }
  return cycles;
}

const OPEN_STEP = new Set(['running', 'waiting']);
