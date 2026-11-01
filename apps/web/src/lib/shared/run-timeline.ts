/**
 * A run as a timeline (docs/run-trace.md#a-run-as-a-timeline, the new look): who leads it, a status pill and its steps in
 * the order they happened. A team run's steps are its members' turns, each named by its result where it has one (a
 * headline: "14 tests pass", "Review: approve"), else by what the member does ("Planned"); any other run's steps are its
 * nodes in run order. The member at work sits on its step with what it does; a wait for a person turns its step amber, a
 * failure red. Members not asked yet, and the run's end, follow as steps to come while the run goes on.
 */
import { teamSnapshotOf, type TeamSnapshot } from './agent-teams';
import type { RunActor } from './run-trace';
import type { Headline } from './run-headlines';
import { cut, type RunModel, type RunSpan } from './run-trace-model';

export type TimelineState = 'done' | 'now' | 'waiting' | 'failed' | 'next';
export type TimelineStatus = 'on-track' | 'needs-you' | 'over-budget' | 'failed' | 'done';

export interface TimelineStep {
  key: string;
  /** What it came to ("14 tests pass", "Planned"), or the node's name. */
  label: string;
  /** Who worked on it: the member, the agent, "the flow". */
  who: string;
  actor?: RunActor;
  state: TimelineState;
  /** The span it opens (and re-runs from, when it failed). */
  spanId?: string;
  /** Epoch ms it started (steps to come: none). */
  at?: number;
  /** What the member at work does, or what a wait asks: the step's bubble. */
  doing?: string;
}

export interface RunTimeline {
  title: string;
  /** Who leads the run: the team's lead, else its first agent; none, and the card shows the flow's icon. */
  lead?: RunActor;
  team?: string;
  status: TimelineStatus;
  steps: TimelineStep[];
  /** A person's turn: the wait's span and what it asks. */
  waiting?: { spanId: string; title: string };
  /** The member over its budget, when one is. */
  overBudget?: string;
  tokens: number;
  ms: number;
}

const same = (a?: string, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** What a member did, by its title or role: "Planned", "Built", "Reviewed". */
const VERBS: Array<[RegExp, string, string, string]> = [
  [/plan|architect/i, 'Planned', 'Planning', 'Plan'],
  [/develop|build|engineer|coder|implement/i, 'Built', 'Building', 'Build'],
  [/review/i, 'Reviewed', 'Reviewing', 'Review'],
  [/fact|verif|check|test|qa/i, 'Checked', 'Checking', 'Check'],
  [/edit/i, 'Edited', 'Editing', 'Edit'],
  [/writ|author|copy/i, 'Wrote', 'Writing', 'Write'],
  [/research|analy/i, 'Researched', 'Researching', 'Research'],
  [/design/i, 'Designed', 'Designing', 'Design'],
  [/translat/i, 'Translated', 'Translating', 'Translate'],
  [/support|answer/i, 'Answered', 'Answering', 'Answer'],
  [/lead|manag|coordinat/i, 'Coordinated', 'Coordinating', 'Coordinate'],
];

export function memberVerb(title: string, role?: string): { done: string; now: string; next: string } {
  for (const [re, done, now, next] of VERBS) if (re.test(title) || (role && re.test(role))) return { done, now, next };
  return { done: 'Done', now: 'Working', next: title };
}

/** The roots of the team's reporting lines: its lead (the first, when there are several). */
export function teamLead(team: TeamSnapshot) {
  return team.members.find((m) => !m.reportsTo || !team.members.some((x) => x.id === m.reportsTo));
}

/** The headline that names a member's turn: its last bad one, else its last good one, between `from` and `to`. */
function resultOf(headlines: Headline[], who: string, from: number, to: number): Headline | undefined {
  const own = headlines.filter((h) => same(h.moment.member, who) && h.at >= from - 1500 && h.at <= to + 1500 && (h.moment.tone === 'ok' || h.moment.tone === 'bad'));
  return own.filter((h) => h.moment.tone === 'bad').at(-1) ?? own.at(-1);
}

function teamSteps(model: RunModel, team: TeamSnapshot, headlines: Headline[]): TimelineStep[] {
  const lead = teamLead(team);
  const members = team.members.filter((m) => m.id !== lead?.id);
  const actorOf = (title: string) => model.actors.find((a) => same(a.actor.name, title))?.actor;
  // Every turn of a member other than the lead, in the order they started; a member asked twice in a row is one step.
  const turns = members
    .flatMap((m) => {
      const actor = actorOf(m.title);
      return (actor ? model.turns[actor.id] ?? [] : []).map((t) => ({ member: m, actor: actor!, turn: t }));
    })
    .sort((a, b) => a.turn.seq - b.turn.seq);
  const merged: typeof turns[] = [];
  for (const t of turns) {
    const prev = merged.at(-1);
    if (prev && prev[0].member.id === t.member.id) prev.push(t);
    else merged.push([t]);
  }
  const steps: TimelineStep[] = merged.map((group) => {
    const first = group[0];
    const last = group[group.length - 1];
    const from = Date.parse(first.turn.at);
    const end = Date.parse(last.turn.at) + last.turn.ms;
    const verb = memberVerb(first.member.title, first.member.role);
    const state: TimelineState = last.turn.status === 'error' ? 'failed' : last.turn.status === 'running' ? 'now' : last.turn.status === 'waiting' ? 'waiting' : 'done';
    const result = state === 'now' ? undefined : resultOf(headlines, first.member.title, from, end);
    return {
      key: `${first.member.id}:${first.turn.key}`,
      label: result ? cut(result.moment.text, 32) : state === 'now' || state === 'waiting' ? verb.now : verb.done,
      who: first.member.title,
      actor: first.actor,
      state: result?.moment.tone === 'bad' && state === 'done' ? 'failed' : state,
      spanId: last.turn.spanId,
      at: from,
    };
  });
  if (model.live) {
    // Who has not had a turn yet comes next, in the team's order.
    for (const m of members)
      if (!steps.some((s) => s.who === m.title)) steps.push({ key: `next:${m.id}`, label: memberVerb(m.title, m.role).next, who: m.title, actor: actorOf(m.title), state: 'next' });
  }
  return steps;
}

/** A flow's own steps: the nodes the run ran, each once, in the order they first ran, with how their last run went. */
function nodeSteps(model: RunModel): TimelineStep[] {
  const top = model.order.filter((s) => s.parentId === model.run?.id && (s.kind === 'step' || s.kind === 'agent' || s.kind === 'wait'));
  const byNode = new Map<string, RunSpan[]>();
  for (const s of top) {
    const key = s.nodeId ?? s.id;
    byNode.set(key, [...(byNode.get(key) ?? []), s]);
  }
  return [...byNode.entries()].map(([key, runs]) => {
    const last = runs[runs.length - 1];
    const state: TimelineState = last.status === 'error' ? 'failed' : last.status === 'running' ? 'now' : last.status === 'waiting' ? 'waiting' : 'done';
    return {
      key,
      label: cut(last.name, 32),
      who: last.actor.type === 'agent' && !same(last.actor.name, last.name) ? last.actor.name : last.actor.role ?? '',
      actor: last.actor.type === 'agent' ? last.actor : undefined,
      state,
      spanId: last.id,
      at: runs[0].t0,
    };
  });
}

/** Up to `max` steps: the first, then the latest ones (where the run is now), so a long run still reads on a phone. */
export function fitSteps(steps: TimelineStep[], max = 6): TimelineStep[] {
  if (steps.length <= max) return steps;
  const now = steps.findIndex((s) => s.state === 'now' || s.state === 'waiting' || s.state === 'failed');
  const focus = now >= 0 ? now : steps.length - 1;
  const end = Math.min(steps.length, Math.max(focus + 2, max - 1));
  return [steps[0], ...steps.slice(end - (max - 1), end)];
}

export function runTimeline(model: RunModel, headlines: Headline[] = []): RunTimeline {
  const team = model.order.map((s) => teamSnapshotOf(s.attrs)).find(Boolean);
  const leadMember = team && teamLead(team);
  const lead =
    (leadMember && model.actors.find((a) => same(a.actor.name, leadMember.title))?.actor) ??
    (leadMember ? { id: `member:${leadMember.id}`, name: leadMember.title, type: 'agent' as const } : model.actors.find((a) => a.actor.type === 'agent')?.actor);
  let steps = team ? teamSteps(model, team, headlines) : [];
  if (!steps.length) steps = nodeSteps(model);

  // The member at work, and a wait for a person, sit on their own step with what they do.
  const wait = model.needsYou.find((n) => n.kind === 'wait');
  for (const w of model.working) {
    const step = [...steps].reverse().find((s) => s.state === 'now' && (same(s.who, w.actor.name) || s.spanId === w.spanId || same(s.actor?.name, w.actor.name)));
    if (step) step.doing ??= cut(w.name, 48);
  }
  if (wait) {
    const name = wait.actor?.name;
    const step = [...steps].reverse().find((s) => s.state !== 'next' && (same(s.who, name) || same(s.actor?.name, name) || same(s.who, wait.caller?.name))) ?? steps.findLast((s) => s.state === 'now');
    if (step) {
      step.state = 'waiting';
      step.doing = cut(wait.title, 60);
    } else steps.push({ key: `wait:${wait.spanId}`, label: 'Needs you', who: name ?? 'You', state: 'waiting', spanId: wait.spanId, doing: cut(wait.title, 60) });
  }
  // A run that ended with an error names the step it failed on, even when the error came after the member's turn.
  if (model.status === 'error' && !model.live && !steps.some((s) => s.state === 'failed')) {
    const failed = model.order.filter((s) => s.status === 'error' && s.kind !== 'run').at(-1);
    const step = steps.find((s) => s.spanId === failed?.id) ?? steps.findLast((s) => s.state !== 'next');
    if (step) step.state = 'failed';
  }
  // The run's end: what it delivered, or where it is going.
  const end: TimelineStep = {
    key: 'end',
    label: model.live || wait ? 'Finish' : model.status === 'error' ? 'Stopped' : model.outcome.reported ? 'Delivered' : 'Done',
    who: 'the flow',
    state: model.live || wait ? 'next' : model.status === 'error' ? 'next' : 'done',
  };
  if (steps.length) steps.push(end);

  // Over budget: a member's tokens past what the team gave it.
  const over = team?.members.find((m) => {
    const stats = model.actors.find((a) => same(a.actor.name, m.title));
    return m.budgetTokens && stats && stats.tokensIn + stats.tokensOut > m.budgetTokens;
  });
  const status: TimelineStatus = model.status === 'error' && !model.live ? 'failed' : wait ? 'needs-you' : over ? 'over-budget' : model.live ? 'on-track' : 'done';
  return {
    title: model.run?.name ?? 'Run',
    ...(lead && { lead }),
    ...(team && { team: team.name }),
    status,
    steps,
    ...(wait && { waiting: { spanId: wait.spanId, title: wait.title } }),
    ...(over && { overBudget: over.title }),
    tokens: model.tokens.inputTokens + model.tokens.outputTokens,
    ms: model.t1 - model.t0,
  };
}

/** How far the line between steps fills: up to the step at work, or all of it when the run is done. */
export function timelineFill(steps: TimelineStep[]): number {
  if (steps.length < 2) return steps[0]?.state === 'done' ? 1 : 0;
  const at = steps.findIndex((s) => s.state !== 'done');
  return at < 0 ? 1 : at / (steps.length - 1);
}
