/**
 * The Run report (docs/run-trace.md#the-run-report): the six built-in checks over a folded journal, and the report
 * built from it — outcome as reported and as checked, who called whom, cycles, problems, claims against evidence, each
 * actor, artifacts, a timeline and what should happen next. Pure: the Report tab computes it live, the Run report node
 * (lib/server/nodes/run-report.ts) at the end of a flow, where it also records the checks and saves the report.
 * Every fact points at the span it came from.
 */
import type { RunActor, RunCheck } from './run-trace';
import { AGENT_NOTES_PATH, BUILTIN_CHECKS, profilePattern, type BuiltinCheckId, type ClaimRule, type RunProfile } from './run-profiles';
import { cut, fmtMs, resultOf, textOf, type RunModel, type RunSpan } from './run-trace-model';

/** A check of the report: a built-in one, or one a node reported (ctx.check). */
export interface ReportCheck extends RunCheck {
  id: string;
  /** Which built-in check found it, or `node`. */
  check: BuiltinCheckId | 'node';
  /** The span it is about (the reply, the tool call). */
  spanId?: string;
  actor?: RunActor;
  /** The step that proves or contradicts it. */
  evidenceSpanId?: string;
}

/** Something an agent said it did, set against the record. */
export interface ReportClaim {
  actor: RunActor;
  /** The reply that says it. */
  spanId: string;
  text: string;
  rule?: ClaimRule;
  verdict: 'proven' | 'contradicted' | 'unproven';
  evidenceSpanId?: string;
  /** Found in the reply's text (no structured part listed it). */
  extracted: boolean;
}

/** A problem someone found, and what became of it. */
export interface ReportProblem {
  text: string;
  foundBy: RunActor;
  spanId: string;
  at: string;
  /** Somebody's later step of the same kind succeeded. */
  fixedBy?: RunActor;
  /** The one who found it saw it pass afterwards. */
  confirmed: boolean;
}

export interface RunReport {
  profile: { id: string; name: string };
  status: RunModel['status'];
  verdict: 'pass' | 'fail' | 'warn';
  /** The profile's word for the verdict ("Ready to merge"). */
  label: string;
  reported?: { text: string; by: string; spanId: string };
  startedAt?: string;
  endedAt?: string;
  durationMs: number;
  checks: ReportCheck[];
  claims: ReportClaim[];
  problems: ReportProblem[];
  calls: Array<{ from: string; to: string; count: number }>;
  cycles: Array<{ a: string; b: string; rounds: number }>;
  actors: Array<{ name: string; type: RunActor['type']; role?: string; workMs: number; steps: number; failedSteps: number; tokens: number; asked: number; results: string[]; made: string[] }>;
  artifacts: Array<{ name: string; kind?: string; url?: string; by?: string; spanId: string }>;
  timeline: Array<{ at: string; text: string; spanId?: string }>;
  next: string[];
  markdown: string;
}

/** What a reply says it did, found and fixed: its structured part, else the profile's claim patterns over its sentences. */
export interface ReplyParts {
  claims: string[];
  findings: string[];
  fixes: string[];
  structured: boolean;
}

const FENCE = /```(?:landflow|json)?\s*(\{[\s\S]*?\})\s*```/gi;
const FAILURE_WORDS = /\b(fail(s|ed|ing|ure)?|error(s)?|broken|couldn'?t|could not|unable|not pass(ing)?|doesn'?t pass|red)\b/i;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v : textOf(v, 300))).filter(Boolean) : []);

/**
 * The structured reply contract: a fenced block (```landflow or ```json) or the reply object itself with `claims`,
 * `findings` and `fixes` lists. Without one, the sentences that match a claim pattern of the profile count as claims.
 */
export function replyParts(reply: unknown, profile: RunProfile): ReplyParts {
  const objects: Record<string, unknown>[] = [];
  if (reply && typeof reply === 'object' && !Array.isArray(reply)) objects.push(reply as Record<string, unknown>);
  const text = typeof reply === 'string' ? reply : textOf(reply, 100_000);
  for (const match of text.matchAll(FENCE)) {
    try {
      const parsed = JSON.parse(match[1]) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) objects.push(parsed as Record<string, unknown>);
    } catch {}
  }
  const structured = objects.find((o) => Array.isArray(o.claims) || Array.isArray(o.findings) || Array.isArray(o.fixes));
  if (structured) return { claims: strings(structured.claims), findings: strings(structured.findings), fixes: strings(structured.fixes), structured: true };
  const patterns = (profile.claims ?? []).map((rule) => profilePattern(rule.claim)).filter((p): p is RegExp => Boolean(p));
  const sentences = text
    .replace(FENCE, ' ')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[\s>*\-•\d.)]+/, '').trim())
    .filter((s) => s.length > 3 && s.length < 400);
  const claims = patterns.length ? sentences.filter((s) => patterns.some((p) => p.test(s))) : [];
  return { claims: [...new Set(claims)], findings: [], fixes: [], structured: false };
}

/** What a tool step worked on: its command, file, path, URL or query. */
function stepDetail(span: RunSpan): string | undefined {
  if (typeof span.input === 'string') return span.input;
  const input = span.input && typeof span.input === 'object' ? (span.input as Record<string, unknown>) : undefined;
  return ['command', 'file_path', 'path', 'url', 'query'].map((k) => input?.[k]).find((v) => typeof v === 'string') as string | undefined;
}
/**
 * A tool step as text to match patterns against: its name, what it worked on, then its whole input
 * (`Bash pnpm test {"command":"pnpm test"}`, `Write src/api.ts {"file_path":"src/api.ts","content":…}`).
 */
const stepText = (span: RunSpan) => {
  const detail = typeof span.input === 'string' ? undefined : stepDetail(span);
  return `${span.name} ${detail ? `${detail} ` : ''}${typeof span.input === 'string' ? span.input : textOf(span.input, 4000)}`;
};
/** A tool step as people read it: "Bash: pnpm typecheck", "Edit: src/api.ts", "Write". */
function stepLabel(span: RunSpan): string {
  const detail = stepDetail(span);
  return cut(detail && !span.name.includes(detail) ? `${span.name}: ${detail}` : span.name, 80);
}
const time = (iso?: string) => (iso ? `${iso.slice(11, 19)} UTC` : '');
const quote = (text: string, max = 140) => `“${cut(text, max)}”`;

/**
 * Spans that carry an agent's answer (a request another agent answered, an agent node's own work), the latest of each
 * actor only: in a flow that sends work back, a later answer replaces the earlier one.
 */
/** The paths a shell step's `git add` commands name (`-A`, `.` and other flags left out). */
export function gitAdded(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n/)
    .flatMap((part) => {
      const words = part.trim().replace(/["']/g, '').split(/\s+/);
      const at = words.findIndex((w, i) => w === 'add' && words.slice(0, i).includes('git'));
      return at < 0 ? [] : words.slice(at + 1).filter((w) => w && !w.startsWith('-') && w !== '.' && !/[{}]/.test(w));
    });
}

function replies(model: RunModel): RunSpan[] {
  const latest = new Map<string, RunSpan>();
  for (const s of model.order) {
    if ((s.kind !== 'delegate' && s.kind !== 'handoff' && s.kind !== 'agent') || s.status !== 'success' || !textOf(s.output)) continue;
    const seen = latest.get(s.actor.id);
    if (!seen || (s.endedAt ?? s.startedAt) >= (seen.endedAt ?? seen.startedAt)) latest.set(s.actor.id, s);
  }
  return [...latest.values()].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1));
}
const toolSteps = (model: RunModel) => model.order.filter((s) => s.kind === 'tool' && !s.hidden);

/** The latest step of `actor` up to `before` whose text matches `pattern`. */
function latestStep(steps: RunSpan[], actorId: string, pattern: RegExp, before?: string): RunSpan | undefined {
  let found: RunSpan | undefined;
  for (const step of steps) {
    if (step.actor.id !== actorId || (before && step.startedAt > before) || !pattern.test(stepText(step))) continue;
    if (!found || step.startedAt >= found.startedAt) found = step;
  }
  return found;
}

/** What the run's branch holds as GitHub sees it (files added or changed against the base), when the run names one. */
export interface ReportOptions {
  branchFiles?: string[];
}

/** The six built-in checks, plus the ones nodes reported, over a folded journal. */
export function runChecks(model: RunModel, profile: RunProfile, options: ReportOptions = {}): { checks: ReportCheck[]; claims: ReportClaim[]; problems: ReportProblem[] } {
  const muted = new Set(profile.mute ?? []);
  const checks: ReportCheck[] = [];
  const claims: ReportClaim[] = [];
  const problems: ReportProblem[] = [];
  const steps = toolSteps(model);
  const answers = replies(model);
  // A check's name is unique within its span (`Claims against evidence: Typecheck passes`): a person's decision is
  // matched to it by span and name.
  const add = (check: BuiltinCheckId, detail: string, fields: Omit<ReportCheck, 'id' | 'check' | 'source' | 'name'>) => {
    if (muted.has(check)) return;
    const name = `${BUILTIN_CHECKS.find((c) => c.id === check)!.name}: ${cut(detail, 80)}`;
    const settled = fields.spanId ? model.checks.find((c) => c.spanId === fields.spanId && c.check.name === name)?.check.resolution : undefined;
    checks.push({ ...fields, name, id: `${check}:${checks.length}`, check, source: 'builtin', ...(settled && { resolution: settled }) });
  };
  const rules = (profile.claims ?? []).map((rule) => ({ rule, claim: profilePattern(rule.claim), evidence: profilePattern(rule.evidence) })).filter((r) => r.claim && r.evidence) as Array<{ rule: ClaimRule; claim: RegExp; evidence: RegExp }>;
  const approval = profilePattern(profile.approval);
  // Rounds: work sent back for a fix (by a Run report's gate or a person) and worked on again is judged on the new
  // round's steps. Role rules, deliveries, hidden failures and node checks before the latest such send-back were handed over.
  const worked = (after: string) => model.order.some((s) => (s.kind === 'tool' || s.kind === 'delegate' || s.kind === 'handoff' || s.kind === 'agent') && s.startedAt > after);
  const roundStart = model.checks
    .map((c) => (c.check.resolution?.decision === 'sent_back' ? c.settledAt : undefined))
    .filter((at): at is string => Boolean(at) && worked(at!))
    .sort()
    .at(-1);
  const thisRound = (span: RunSpan) => !roundStart || span.startedAt > roundStart;

  // 1. Claims against evidence: every claim is listed, and each rule is checked once per answer.
  for (const span of answers) {
    const parts = replyParts(span.output, profile);
    const checked = new Set<string>();
    for (const text of parts.claims) {
      const matched = rules.find((r) => r.claim.test(text));
      if (!matched) {
        claims.push({ actor: span.actor, spanId: span.id, text, verdict: 'unproven', extracted: !parts.structured });
        continue;
      }
      const step = latestStep(steps, span.actor.id, matched.evidence, span.endedAt);
      const verdict = !step ? 'unproven' : step.status === 'success' ? 'proven' : step.status === 'error' ? 'contradicted' : 'unproven';
      claims.push({ actor: span.actor, spanId: span.id, text, rule: matched.rule, verdict, ...(step && { evidenceSpanId: step.id }), extracted: !parts.structured });
      if (checked.has(matched.rule.id)) continue;
      checked.add(matched.rule.id);
      add('claims', matched.rule.label, {
        status: verdict === 'proven' ? 'pass' : verdict === 'contradicted' ? 'fail' : 'warn',
        subject: span.actor.name,
        message:
          verdict === 'proven'
            ? `${span.actor.name}: ${matched.rule.label.toLowerCase()}, and the last step that shows it passed: ${stepLabel(step!)} (${time(step!.endedAt ?? step!.startedAt)}).`
            : verdict === 'contradicted'
              ? `${span.actor.name} says ${quote(text)}, but the last step that would show it failed: ${stepLabel(step!)} (${time(step!.endedAt ?? step!.startedAt)}).`
              : `${span.actor.name} says ${quote(text)}, and no step in the record shows it.`,
        spanId: span.id,
        actor: span.actor,
        ...(step && { evidenceSpanId: step.id }),
      });
    }
  }

  // 2. Role rules.
  for (const rule of profile.roles ?? []) {
    const who = profilePattern(rule.actor);
    const deny = profilePattern(rule.deny);
    if (!who || !deny) continue;
    const byActor = new Map<string, RunSpan[]>();
    for (const step of steps) if (thisRound(step) && who.test(`${step.actor.name} ${step.actor.id}`) && deny.test(stepText(step))) byActor.set(step.actor.id, [...(byActor.get(step.actor.id) ?? []), step]);
    for (const list of byActor.values()) {
      const first = list[0];
      add('roles', `${rule.label} (${first.actor.name})`, { status: 'fail', subject: first.actor.name, message: `${rule.label}: ${first.actor.name} made ${list.length} step${list.length === 1 ? '' : 's'} its role excludes (first: ${stepLabel(first)}).`, spanId: first.id, actor: first.actor, evidenceSpanId: first.id });
    }
  }

  // 3. Unfinished work: requests left undelivered, spans left open in a finished run, deliveries that never came.
  const ended = !model.live && model.status !== 'waiting';
  // A request asked again later counts by its latest round.
  const lastAsk = new Map<string, string>();
  for (const span of model.order) if (span.kind === 'delegate' || span.kind === 'handoff') lastAsk.set(`${span.caller?.id}\u0000${span.actor.id}`, span.id);
  for (const span of model.order) {
    if (span.kind === 'delegate' || span.kind === 'handoff') {
      const [label] = resultOf(span);
      if (label === 'Left undelivered' && lastAsk.get(`${span.caller?.id}\u0000${span.actor.id}`) === span.id) add('unfinished', `${span.actor.name} left undelivered`, { status: 'fail', subject: span.actor.name, message: `${span.caller?.name ?? 'The run'} asked ${span.actor.name} ${quote(textOf(span.input), 80)}, and it was left undelivered${span.error ? `: ${cut(span.error, 120)}` : ''}.`, spanId: span.id, actor: span.actor });
    } else if (ended && (span.status === 'running' || span.status === 'waiting') && span.kind !== 'run') {
      add('unfinished', `${span.name} left ${span.status}`, { status: 'fail', subject: span.actor.name, message: `${span.name} was still ${span.status} when the run ended.`, spanId: span.id, actor: span.actor });
    }
  }
  for (const rule of profile.deliveries ?? []) {
    const work = profilePattern(rule.work);
    const delivery = profilePattern(rule.delivery);
    if (!work || !delivery) continue;
    const actors = new Map<string, RunActor>();
    for (const step of steps) if (step.status === 'success' && thisRound(step) && work.test(stepText(step))) actors.set(step.actor.id, step.actor);
    for (const actor of actors.values()) {
      const done = steps.filter((s) => s.status === 'success');
      const lastWork = latestStep(done, actor.id, work)!;
      const lastDelivery = latestStep(done, actor.id, delivery);
      const delivered = lastDelivery && lastDelivery.startedAt >= lastWork.startedAt ? lastDelivery : undefined;
      const after = done.filter((s) => s.actor.id === actor.id && thisRound(s) && work.test(stepText(s)) && (!lastDelivery || s.startedAt > lastDelivery.startedAt)).length;
      add('unfinished', `${rule.label} (${actor.name})`, {
        status: delivered ? 'pass' : 'fail',
        subject: actor.name,
        message: delivered ? `${actor.name}: ${rule.label.toLowerCase()} (${time(delivered.startedAt)}).` : `${actor.name} made ${after} change${after === 1 ? '' : 's'} (last: ${stepLabel(lastWork)}) that ${after === 1 ? 'was' : 'were'} never delivered: ${rule.label.toLowerCase()}.`,
        spanId: lastWork.id,
        actor,
        ...(delivered && { evidenceSpanId: delivered.id }),
      });
    }
  }

  // 4. Problems sent back: a problem an answer knew about (its findings, or a failing check-type step it ran last) that
  // was signed off anyway, or that no later request took up.
  for (const span of answers) {
    const parts = replyParts(span.output, profile);
    const found: Array<{ text: string; step?: RunSpan; rule?: ClaimRule }> = parts.findings.map((text) => ({ text }));
    for (const r of rules) {
      // An answer that claims the opposite is the claims check's to judge, not a problem it found.
      if (parts.claims.some((claim) => r.claim.test(claim))) continue;
      const step = latestStep(steps, span.actor.id, r.evidence, span.endedAt);
      if (step?.status === 'error' && !found.some((f) => f.rule === r.rule)) found.push({ text: `Failing: ${stepLabel(step)}`, step, rule: r.rule });
    }
    if (!found.length) continue;
    const reply = textOf(span.output, 100_000);
    const signedOff = Boolean(approval?.test(reply));
    const laterRound = model.order.some((s) => (s.kind === 'delegate' || s.kind === 'handoff') && s.startedAt > (span.endedAt ?? span.startedAt) && s.id !== span.id);
    for (const problem of found) {
      // Fixed: someone's later step of the same kind passed; confirmed: the one who found it saw it pass.
      const later = problem.rule ? steps.filter((s) => s.status === 'success' && s.startedAt > (problem.step?.startedAt ?? span.startedAt) && profilePattern(problem.rule!.evidence)!.test(stepText(s))) : [];
      const fixer = later.find((s) => s.actor.id !== span.actor.id)?.actor ?? later[0]?.actor;
      problems.push({ text: problem.text, foundBy: span.actor, spanId: problem.step?.id ?? span.id, at: problem.step?.endedAt ?? span.endedAt ?? span.startedAt, ...(fixer && { fixedBy: fixer }), confirmed: later.some((s) => s.actor.id === span.actor.id) });
      const sentBack = !signedOff && laterRound;
      add('sent_back', problem.text, {
        status: sentBack || fixer ? 'pass' : 'fail',
        subject: span.actor.name,
        message: sentBack || fixer
          ? `${span.actor.name} found “${problem.text}”${fixer ? `; ${fixer.name} fixed it` : ' and it went back for another round'}.`
          : signedOff
            ? `${span.actor.name} found “${problem.text}” and still signed the work off.`
            : `${span.actor.name} found “${problem.text}”, and it never went back to anyone who could fix it.`,
        spanId: span.id,
        actor: span.actor,
        ...(problem.step && { evidenceSpanId: problem.step.id }),
      });
    }
  }

  // 5. Hidden failures: a step that failed, was never redone successfully, and the answer above it does not mention.
  const signature = (span: RunSpan) => cut(stepText(span).toLowerCase(), 120);
  // One check per actor and kind of step: the latest failure of it.
  const latestFailures = new Map<string, RunSpan>();
  for (const failed of model.failedSteps) {
    const span = model.spans[failed.spanId];
    if (!span || span.kind !== 'tool' || !thisRound(span)) continue;
    const rule = rules.find((r) => r.evidence.test(stepText(span)));
    const key = `${span.actor.id}\u0000${rule ? rule.rule.id : signature(span)}`;
    const seen = latestFailures.get(key);
    if (!seen || span.startedAt >= seen.startedAt) latestFailures.set(key, span);
  }
  for (const span of latestFailures.values()) {
    const rule = rules.find((r) => r.evidence.test(stepText(span)));
    const redone = steps.some((s) => s.actor.id === span.actor.id && s.status === 'success' && s.startedAt > span.startedAt && (rule ? rule.evidence.test(stepText(s)) : signature(s) === signature(span)));
    if (redone) continue;
    let answer: RunSpan | undefined;
    for (let id = span.parentId; id; id = model.spans[id]?.parentId) {
      const parent = model.spans[id];
      if (parent && (parent.kind === 'delegate' || parent.kind === 'handoff' || parent.kind === 'agent')) {
        answer = parent;
        break;
      }
    }
    if (!answer || answer.status !== 'success') continue;
    const mentioned = FAILURE_WORDS.test(textOf(answer.output, 100_000));
    add('hidden', stepLabel(span), {
      status: mentioned ? 'pass' : 'fail',
      subject: span.actor.name,
      message: mentioned ? `${span.actor.name}: ${stepLabel(span)} failed, and its answer says so.` : `${span.actor.name}: ${stepLabel(span)} failed (${time(span.endedAt)}), was never redone, and the answer doesn't mention it.`,
      spanId: span.id,
      actor: span.actor,
      evidenceSpanId: span.id,
    });
  }

  // 6. Agent notes committed: on the branch as GitHub sees it when the run names one (however they got there), else a
  // `git add` in this round that names them.
  const notes = new RegExp(AGENT_NOTES_PATH);
  if (options.branchFiles) {
    const found = options.branchFiles.filter((path) => notes.test(path));
    if (found.length)
      add('notes', found.slice(0, 3).join(', '), {
        status: 'fail',
        subject: 'The branch',
        message: `The branch holds ${found.length === 1 ? 'an agent’s notes' : `${found.length} files of agents’ notes`}: ${found.join(', ')}. They are not part of the work: remove them from the branch (\`git rm --cached <path>\`, commit, push).`,
      });
  } else {
    for (const step of steps) {
      if (!thisRound(step) || step.status !== 'success') continue;
      const named = gitAdded(stepDetail(step) ?? '').filter((path) => notes.test(path));
      if (named.length)
        add('notes', `${named.join(', ')} (${step.actor.name})`, {
          status: 'fail',
          subject: step.actor.name,
          message: `${step.actor.name} added ${named.join(', ')} to a commit: an agent’s own notes are not part of the work.`,
          spanId: step.id,
          actor: step.actor,
          evidenceSpanId: step.id,
        });
    }
  }

  // Checks nodes and the host reported (ctx.check, a team's Grounded, Review and Budget, a guardrail), with a person's
  // decision when there is one. The six above, which a Run report records on their spans, are worked out again instead.
  const builtinNames = BUILTIN_CHECKS.map((c) => `${c.name}: `);
  for (const item of model.checks) {
    if (builtinNames.some((prefix) => item.check.name.startsWith(prefix))) continue;
    if (roundStart && item.check.resolution?.decision === 'sent_back' && item.settledAt && item.settledAt <= roundStart) continue;
    checks.push({ ...item.check, id: item.id, check: 'node', spanId: item.spanId, ...(item.actor && { actor: item.actor }) });
  }
  return { checks, claims, problems };
}

const MARK: Record<RunCheck['status'], string> = { pass: '✓', fail: '✗', warn: '!', skip: '–' };

/** The report of a run, from its folded journal and the flow's profile; `summary` is a model's few lines written from these facts. */
export function buildRunReport(model: RunModel, profile: RunProfile, options: ReportOptions & { title?: string; summary?: { text: string; by: string } } = {}): RunReport {
  const { checks, claims, problems } = runChecks(model, profile, options);
  const open = (c: ReportCheck) => !c.resolution || c.resolution.decision !== 'accepted';
  const failed = checks.filter((c) => c.status === 'fail' && open(c));
  const warned = checks.filter((c) => c.status === 'warn' && open(c));
  const runFailed = model.status === 'error' || model.status === 'canceled';
  const verdict: RunReport['verdict'] = failed.length || runFailed ? 'fail' : warned.length ? 'warn' : 'pass';
  const label = verdict === 'fail' ? (profile.words?.fail ?? 'Needs attention') : (profile.words?.pass ?? 'Done');
  const name = (id: string) => model.actors.find((a) => a.actor.id === id)?.actor.name ?? id;
  const calls = model.edges.map((e) => ({ from: name(e.from), to: name(e.to), count: e.delegate + e.handoff + e.wait })).filter((c) => c.count > 0);
  const cycles = model.cycles.filter((c) => c.rounds > 0).map((c) => ({ a: name(c.a), b: name(c.b), rounds: c.rounds }));
  const kinds = profile.artifacts ?? [];
  const artifacts = [...model.artifacts]
    .sort((x, y) => (kinds.indexOf(x.artifact.kind ?? '') + 1 || 99) - (kinds.indexOf(y.artifact.kind ?? '') + 1 || 99))
    .filter((a) => a.artifact.kind !== 'report')
    .map((a) => ({ name: a.artifact.name, ...(a.artifact.kind && { kind: a.artifact.kind }), ...(a.artifact.url && { url: a.artifact.url }), ...(a.actor && { by: a.actor.name }), spanId: a.spanId }));
  const actors = model.actors
    .filter((a) => a.actor.type === 'agent' || a.actor.type === 'human')
    .map((a) => ({
      name: a.actor.name,
      type: a.actor.type,
      ...(a.actor.role && { role: a.actor.role }),
      workMs: a.workMs,
      steps: a.steps,
      failedSteps: a.failedSteps,
      tokens: a.tokensIn + a.tokensOut,
      asked: a.asked,
      results: a.results,
      made: a.artifacts.map((x) => x.artifact.name),
    }));
  const timeline: RunReport['timeline'] = [];
  if (model.startedAt) timeline.push({ at: model.startedAt, text: 'The run started', spanId: 'run' });
  for (const span of model.order) {
    if (span.kind === 'delegate' || span.kind === 'handoff') {
      timeline.push({ at: span.startedAt, text: `${span.caller?.name ?? 'The run'} asked ${span.actor.name}`, spanId: span.id });
      if (span.endedAt) timeline.push({ at: span.endedAt, text: `${span.actor.name}: ${resultOf(span)[0].toLowerCase()}`, spanId: span.id });
    } else if (span.kind === 'wait') timeline.push({ at: span.startedAt, text: `Waited for ${span.actor.name}: ${span.name}`, spanId: span.id });
    else if (span.kind === 'tool' && span.status === 'error') timeline.push({ at: span.endedAt ?? span.startedAt, text: `${span.actor.name}: ${stepLabel(span)} failed`, spanId: span.id });
  }
  for (const a of model.artifacts) if (a.artifact.kind !== 'report') timeline.push({ at: a.at, text: `${a.actor?.name ?? 'The run'} made ${a.artifact.name}`, spanId: a.spanId });
  if (model.endedAt) timeline.push({ at: model.endedAt, text: `The run ended: ${model.status}`, spanId: 'run' });
  timeline.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0));

  const next: string[] = [];
  for (const c of failed) {
    if (c.check === 'claims') next.push(`Have ${c.subject} redo it and show a passing step: ${c.message}`);
    else if (c.check === 'roles') next.push(`Keep ${c.subject} to its role: ${c.message}`);
    else if (c.check === 'unfinished') next.push(`Finish it: ${c.message}`);
    else if (c.check === 'sent_back') next.push(`Send it back for a fix: ${c.message}`);
    else if (c.check === 'hidden') next.push(`Look at it: ${c.message}`);
    else next.push(`${c.name}: ${c.message ?? 'failed'}`);
  }
  if (runFailed && model.run?.error) next.unshift(`The run failed: ${cut(model.run.error, 200)}`);
  if (!next.length) next.push(verdict === 'warn' ? 'Nothing failed; look at the warnings above.' : 'Nothing to do: every check passed.');

  const report: Omit<RunReport, 'markdown'> = {
    profile: { id: profile.id, name: profile.name },
    status: model.status,
    verdict,
    label,
    ...(model.outcome.reported && { reported: model.outcome.reported }),
    ...(model.startedAt && { startedAt: model.startedAt }),
    ...(model.endedAt && { endedAt: model.endedAt }),
    durationMs: Math.max(0, model.t1 - model.t0),
    checks,
    claims,
    problems,
    calls,
    cycles,
    actors,
    artifacts,
    timeline,
    next,
  };
  return { ...report, markdown: reportMarkdown(report, options) };
}

/** The checks of a report in a few words: "2 of 6 checks failed", "1 to look at", "all 4 checks passed", "no checks". */
export function checksLine(report: Pick<RunReport, 'checks'>): string {
  const open = report.checks.filter((c) => c.resolution?.decision !== 'accepted');
  const failed = open.filter((c) => c.status === 'fail').length;
  const warned = open.filter((c) => c.status === 'warn').length;
  const total = report.checks.length;
  if (!total) return 'no checks';
  if (failed) return `${failed} of ${total} check${total === 1 ? '' : 's'} failed`;
  if (warned) return `${warned} to look at`;
  return total === 1 ? 'the check passed' : `all ${total} checks passed`;
}

/** The report as Markdown: what the Run report node saves and posts (a PR comment, a ticket note, Slack). */
export function reportMarkdown(report: Omit<RunReport, 'markdown'>, options: { title?: string; summary?: { text: string; by: string } } = {}): string {
  const lines: string[] = [];
  const failed = report.checks.filter((c) => c.status === 'fail').length;
  lines.push(`## ${options.title ?? 'Run report'}`, '');
  lines.push(`**${report.verdict === 'fail' ? '✗' : report.verdict === 'warn' ? '!' : '✓'} ${report.label}** · ${report.profile.name} profile · ${fmtMs(report.durationMs)} · ${failed} of ${report.checks.length} check${report.checks.length === 1 ? '' : 's'} failed`, '');
  if (report.reported) lines.push(`**Reported** by ${report.reported.by}: ${quote(report.reported.text, 300)}`, '');
  if (options.summary) lines.push(`**Summary** (written by ${options.summary.by} from the facts below): ${options.summary.text.trim()}`, '');
  if (report.checks.length) {
    lines.push('### Checks', '');
    const order = { fail: 0, warn: 1, pass: 2, skip: 3 } as const;
    for (const c of [...report.checks].sort((a, b) => order[a.status] - order[b.status])) lines.push(`- ${MARK[c.status]} **${c.name}**: ${c.message ?? c.status}${c.resolution ? ` _(${c.resolution.decision === 'accepted' ? 'accepted as is' : 'sent back'} by ${c.resolution.by})_` : ''}`);
    lines.push('');
  }
  if (report.calls.length) {
    lines.push('### Who called whom', '');
    for (const c of report.calls) lines.push(`- ${c.from} → ${c.to} ×${c.count}`);
    lines.push('');
  }
  if (report.cycles.length) {
    lines.push('### Cycles', '');
    for (const c of report.cycles) lines.push(`- ${c.a} ⇄ ${c.b}: ${c.rounds} round${c.rounds === 1 ? '' : 's'}`);
    lines.push('');
  }
  if (report.problems.length) {
    lines.push('### Problems', '');
    for (const p of report.problems) lines.push(`- ${p.text}: found by ${p.foundBy.name} (${time(p.at)})${p.fixedBy ? `, fixed by ${p.fixedBy.name}${p.confirmed ? ', confirmed' : ''}` : ', not fixed'}`);
    lines.push('');
  }
  if (report.claims.length) {
    lines.push('### Claims against evidence', '');
    const word = { proven: '✓ proven', contradicted: '✗ contradicted', unproven: '! not shown' } as const;
    for (const c of report.claims) lines.push(`- ${c.actor.name}: ${quote(c.text)} — ${word[c.verdict]}${c.extracted ? ' _(extracted from the reply)_' : ''}`);
    lines.push('');
  }
  if (report.actors.length) {
    lines.push('### Each actor', '');
    for (const a of report.actors) {
      const facts = [fmtMs(a.workMs), `${a.steps} step${a.steps === 1 ? '' : 's'}${a.failedSteps ? ` (${a.failedSteps} failed)` : ''}`];
      if (a.tokens) facts.push(`${a.tokens.toLocaleString('en-US')} tokens`);
      if (a.asked) facts.push(`asked ×${a.asked}`);
      if (a.results.length) facts.push(a.results.join(', '));
      lines.push(`- **${a.name}**${a.role ? ` (${a.role})` : ''}: ${facts.join(' · ')}${a.made.length ? `; made ${a.made.join(', ')}` : ''}`);
    }
    lines.push('');
  }
  if (report.artifacts.length) {
    lines.push('### Artifacts', '');
    for (const a of report.artifacts) lines.push(`- ${a.url ? `[${a.name}](${a.url})` : a.name}${a.kind ? ` · ${a.kind}` : ''}${a.by ? ` · ${a.by}` : ''}`);
    lines.push('');
  }
  if (report.timeline.length) {
    lines.push('<details><summary>Timeline</summary>', '');
    for (const t of report.timeline.slice(0, 200)) lines.push(`- ${time(t.at)} ${t.text}`);
    lines.push('', '</details>', '');
  }
  lines.push('### What should happen next', '');
  for (const n of report.next) lines.push(`- ${n}`);
  return lines.join('\n').trim() + '\n';
}
