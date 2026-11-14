/**
 * Velocity signals (docs/second-brain.md#nightly-sdlc-velocity): what the company's work events say about how fast
 * software moves, as numbers about the process: cycle time and review wait per repository, the share of pull requests
 * that need rework, flaky CI (a failure, then a pass on the same commit), repeated toil and review ping-pong.
 *
 * Pure: no database, no model. The caller hands over events a system reader may see (`org` and no owner, never private),
 * already narrowed to plain fields (`signalEventOf`). A signal is about a repository, a kind of work or a phrase, never
 * about a person: no field here carries an author, a reviewer or an email, and nothing ranks people.
 */
import type { UsageEvent } from '../../shared/brain';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** Thresholds: a signal is raised only above one. Each is a named constant so the template's behaviour is easy to tune. */
export const THRESHOLDS = {
  /** Median opened-to-merged time per repository, in hours. */
  cycleTimeP50Hours: 72,
  /** Median wait for a first review per repository, in hours ("a PR waits over a day"). */
  reviewWaitP50Hours: 24,
  /** The share of pull requests that got a "changes requested" review (0..1). */
  reworkShare: 0.35,
  /** Commits that failed CI and then passed with no change (per repository). */
  flakyCiPairs: 2,
  /** The same manual sequence or repeated usage signature, this many times. */
  toilRepeats: 5,
  /** Pull requests with this many review rounds or more. */
  handoffRounds: 3,
  handoffPullRequests: 2,
  /** Fewer finished pull requests than this in a repository: too few to say anything about it. */
  minSample: 3,
} as const;

/** The event kinds that count as repeated toil besides work sessions: asks and searches that came back empty again and again. */
export const TOIL_USAGE_KINDS = ['spotlight.asked', 'search.empty', 'tool.missing'];

export type SignalType = 'cycleTime' | 'reviewWait' | 'rework' | 'flakyCi' | 'toil' | 'handoffs';

/** What the signals read of a ledger event: only fields about the work, never who did it. */
export interface SignalEvent {
  id: string;
  kind: string;
  /** Epoch milliseconds. */
  at: number;
  repo?: string;
  prNumber?: number;
  /** For `work.pr_reviewed`: approved, changes_requested or commented. */
  reviewState?: string;
  /** For `work.pr_reviewed`: how long the review waited, when the sender knew. */
  waitedMs?: number;
  /** The commit a CI run belongs to (`sha`, `headSha` or `commit`), else the pull request is the key. */
  commit?: string;
  /** A normalised phrase (work session titles) or the ledger signature (usage kinds). */
  phrase?: string;
}

export interface Window {
  from: number;
  to: number;
}

export interface Signal {
  type: SignalType;
  /** What it is about: a repository (`acme/api`), a kind of work or a phrase. Never a person. */
  scope: string;
  /** Stable per type and scope: the nightly template's fingerprint, so a signal refreshes its suggestion. */
  key: string;
  /** The headline number: hours, a share or a count. */
  value: number;
  unit: 'hours' | 'share' | 'count';
  threshold: number;
  /** How many things it was computed from (pull requests, commits, repeats). */
  count: number;
  /** Event ids, at most 12. */
  evidence: string[];
  /** One plain sentence. */
  summary: string;
  detail: Record<string, number | string>;
}

export interface VelocityResult {
  window: Window;
  cycleTime: Array<{ repo: string; p50: number; p90: number; count: number; evidence: string[] }>;
  reviewWait: Array<{ repo: string; p50: number; p90: number; count: number; evidence: string[] }>;
  rework: Array<{ repo: string; share: number; pullRequests: number; withChanges: number; evidence: string[] }>;
  flakyCi: Array<{ repo: string; pairs: number; commits: number; evidence: string[] }>;
  toil: Array<{ phrase: string; source: 'work.session' | 'usage'; repeats: number; evidence: string[] }>;
  handoffs: Array<{ repo: string; pullRequests: number; rounds: number; evidence: string[] }>;
}

const MAX_EVIDENCE = 12;
const round1 = (n: number) => Math.round(n * 10) / 10;

/** The p-th percentile (nearest rank) of a list; 0 for an empty one. */
export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const prKey = (e: SignalEvent) => (e.repo && e.prNumber !== undefined ? `${e.repo}#${e.prNumber}` : undefined);

function groupBy<T>(items: T[], key: (item: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    out.set(k, [...(out.get(k) ?? []), item]);
  }
  return out;
}

/** A work session's title as a phrase that repeats: lower case, numbers and ids folded, short. */
export function normalisePhrase(title: string): string {
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[0-9a-f]{7,}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/[^a-z# ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

/** The number or string attribute `name`, as a number. */
const num = (attrs: UsageEvent['attrs'], name: string): number | undefined => {
  const v = attrs?.[name];
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};
const str = (attrs: UsageEvent['attrs'], name: string): string | undefined => (typeof attrs?.[name] === 'string' && attrs[name] ? String(attrs[name]) : undefined);

/** A ledger event narrowed to the fields the signals use. Drops everything that names a person (`actor`, owner, email). */
export function signalEventOf(event: UsageEvent): SignalEvent {
  const attrs = event.attrs;
  const isSession = event.kind === 'work.session';
  const phrase = isSession ? normalisePhrase(str(attrs, 'title') ?? event.message ?? '') : TOIL_USAGE_KINDS.includes(event.kind) ? event.signature : undefined;
  return {
    id: event.id,
    kind: event.kind,
    at: Date.parse(event.at),
    ...(str(attrs, 'repo') && { repo: str(attrs, 'repo') }),
    ...(num(attrs, 'prNumber') !== undefined && { prNumber: num(attrs, 'prNumber') }),
    ...(str(attrs, 'reviewState') && { reviewState: str(attrs, 'reviewState') }),
    ...(num(attrs, 'waitedMs') !== undefined && { waitedMs: num(attrs, 'waitedMs') }),
    ...((str(attrs, 'sha') ?? str(attrs, 'headSha') ?? str(attrs, 'commit')) && { commit: str(attrs, 'sha') ?? str(attrs, 'headSha') ?? str(attrs, 'commit') }),
    ...(phrase && { phrase }),
  };
}

const first = <T>(items: T[], pick: (item: T) => number) => items.reduce((a, b) => (pick(b) < pick(a) ? b : a));

/** All the signals' numbers over `events` inside `window` (an event outside it, or without a time, is ignored). */
export function velocitySignals(events: SignalEvent[], window: Window, options: { repos?: string[] } = {}): VelocityResult {
  const wanted = options.repos?.length ? new Set(options.repos.map((r) => r.toLowerCase())) : undefined;
  const inWindow = events.filter((e) => Number.isFinite(e.at) && e.at >= window.from && e.at <= window.to && (!wanted || !e.repo || wanted.has(e.repo.toLowerCase())));

  // Pull requests, by repo#number: opened, merged, reviews.
  const prs = groupBy(inWindow.filter((e) => e.kind.startsWith('work.pr_') || e.kind === 'work.review_requested'), prKey);
  const cycles = new Map<string, { hours: number[]; evidence: string[] }>();
  const waits = new Map<string, { hours: number[]; evidence: string[] }>();
  const rework = new Map<string, { prs: number; withChanges: number; evidence: string[] }>();
  const handoffs = new Map<string, { prs: number; rounds: number; evidence: string[] }>();
  const bucket = <T>(map: Map<string, T>, repo: string, make: () => T) => {
    if (!map.has(repo)) map.set(repo, make());
    return map.get(repo)!;
  };

  for (const [key, list] of prs) {
    const repo = key.slice(0, key.lastIndexOf('#'));
    const opened = list.filter((e) => e.kind === 'work.pr_opened');
    const merged = list.filter((e) => e.kind === 'work.pr_merged');
    const reviews = list.filter((e) => e.kind === 'work.pr_reviewed').sort((a, b) => a.at - b.at);
    if (opened.length && merged.length) {
      const o = first(opened, (e) => e.at);
      const m = first(merged, (e) => e.at);
      if (m.at >= o.at) {
        const c = bucket(cycles, repo, () => ({ hours: [], evidence: [] }));
        c.hours.push((m.at - o.at) / HOUR_MS);
        c.evidence.push(m.id);
      }
    }
    if (reviews.length) {
      // How long the first review waited: the sender's own figure, else opened to first review.
      const firstReview = reviews[0];
      const asked = [...opened, ...list.filter((e) => e.kind === 'work.review_requested')];
      const waitedMs = firstReview.waitedMs ?? (asked.length ? Math.max(0, firstReview.at - first(asked, (e) => e.at).at) : undefined);
      if (waitedMs !== undefined) {
        const w = bucket(waits, repo, () => ({ hours: [], evidence: [] }));
        w.hours.push(waitedMs / HOUR_MS);
        w.evidence.push(firstReview.id);
      }
    }
    if (opened.length || reviews.length) {
      const r = bucket(rework, repo, () => ({ prs: 0, withChanges: 0, evidence: [] }));
      r.prs += 1;
      const changed = reviews.filter((e) => e.reviewState === 'changes_requested');
      if (changed.length) {
        r.withChanges += 1;
        r.evidence.push(changed[0].id);
      }
    }
    if (reviews.length >= THRESHOLDS.handoffRounds) {
      const h = bucket(handoffs, repo, () => ({ prs: 0, rounds: 0, evidence: [] }));
      h.prs += 1;
      h.rounds += reviews.length;
      h.evidence.push(reviews[reviews.length - 1].id);
    }
  }

  // Flaky CI: a failure and then a pass on the same commit (no pull request needed: the commit is the key).
  const ci = groupBy(
    inWindow.filter((e) => (e.kind === 'work.ci_failed' || e.kind === 'work.ci_passed') && e.repo),
    (e) => `${e.repo}@${e.commit ?? prKey(e) ?? ''}`,
  );
  const flaky = new Map<string, { pairs: number; commits: Set<string>; evidence: string[] }>();
  for (const [key, list] of ci) {
    if (key.endsWith('@')) continue;
    const sorted = [...list].sort((a, b) => a.at - b.at);
    const failure = sorted.find((e) => e.kind === 'work.ci_failed');
    const pass = failure && sorted.find((e) => e.kind === 'work.ci_passed' && e.at >= failure.at);
    if (!failure || !pass) continue;
    const repo = key.slice(0, key.indexOf('@'));
    const f = bucket(flaky, repo, () => ({ pairs: 0, commits: new Set<string>(), evidence: [] }));
    f.pairs += 1;
    f.commits.add(key);
    f.evidence.push(failure.id, pass.id);
  }

  // Toil: the same phrase (a session title, a usage signature) again and again.
  const toil = [
    ...[...groupBy(inWindow.filter((e) => e.kind === 'work.session' && e.phrase && e.phrase.length >= 6), (e) => e.phrase)].map(([phrase, list]) => ({ phrase, source: 'work.session' as const, repeats: list.length, evidence: list.map((e) => e.id).slice(0, MAX_EVIDENCE) })),
    ...[...groupBy(inWindow.filter((e) => TOIL_USAGE_KINDS.includes(e.kind) && e.phrase), (e) => `${e.kind} ${e.phrase}`)].map(([phrase, list]) => ({ phrase, source: 'usage' as const, repeats: list.length, evidence: list.map((e) => e.id).slice(0, MAX_EVIDENCE) })),
  ].sort((a, b) => b.repeats - a.repeats || a.phrase.localeCompare(b.phrase));

  const stats = (map: Map<string, { hours: number[]; evidence: string[] }>) =>
    [...map].map(([repo, v]) => ({ repo, p50: round1(percentile(v.hours, 0.5)), p90: round1(percentile(v.hours, 0.9)), count: v.hours.length, evidence: v.evidence.slice(0, MAX_EVIDENCE) })).sort((a, b) => a.repo.localeCompare(b.repo));

  return {
    window,
    cycleTime: stats(cycles),
    reviewWait: stats(waits),
    rework: [...rework].map(([repo, v]) => ({ repo, share: v.prs ? Math.round((v.withChanges / v.prs) * 100) / 100 : 0, pullRequests: v.prs, withChanges: v.withChanges, evidence: v.evidence.slice(0, MAX_EVIDENCE) })).sort((a, b) => a.repo.localeCompare(b.repo)),
    flakyCi: [...flaky].map(([repo, v]) => ({ repo, pairs: v.pairs, commits: v.commits.size, evidence: v.evidence.slice(0, MAX_EVIDENCE) })).sort((a, b) => a.repo.localeCompare(b.repo)),
    toil,
    handoffs: [...handoffs].map(([repo, v]) => ({ repo, pullRequests: v.prs, rounds: v.rounds, evidence: v.evidence.slice(0, MAX_EVIDENCE) })).sort((a, b) => a.repo.localeCompare(b.repo)),
  };
}

/** The signals above their thresholds, worst first within each type. */
export function flaggedSignals(result: VelocityResult): Signal[] {
  const out: Signal[] = [];
  const days = Math.max(1, Math.round((result.window.to - result.window.from) / DAY_MS));
  for (const c of result.cycleTime) {
    if (c.count >= THRESHOLDS.minSample && c.p50 > THRESHOLDS.cycleTimeP50Hours)
      out.push({ type: 'cycleTime', scope: c.repo, key: `cycleTime:${c.repo}`, value: c.p50, unit: 'hours', threshold: THRESHOLDS.cycleTimeP50Hours, count: c.count, evidence: c.evidence, summary: `Pull requests in ${c.repo} took a median of ${c.p50} hours to merge (the slowest tenth took ${c.p90}) over ${c.count} pull requests in ${days} days.`, detail: { p50: c.p50, p90: c.p90 } });
  }
  for (const w of result.reviewWait) {
    if (w.count >= THRESHOLDS.minSample && w.p50 > THRESHOLDS.reviewWaitP50Hours)
      out.push({ type: 'reviewWait', scope: w.repo, key: `reviewWait:${w.repo}`, value: w.p50, unit: 'hours', threshold: THRESHOLDS.reviewWaitP50Hours, count: w.count, evidence: w.evidence, summary: `Pull requests in ${w.repo} waited a median of ${w.p50} hours for a first review (the slowest tenth ${w.p90}) over ${w.count} pull requests in ${days} days.`, detail: { p50: w.p50, p90: w.p90 } });
  }
  for (const r of result.rework) {
    if (r.pullRequests >= THRESHOLDS.minSample && r.share > THRESHOLDS.reworkShare)
      out.push({ type: 'rework', scope: r.repo, key: `rework:${r.repo}`, value: r.share, unit: 'share', threshold: THRESHOLDS.reworkShare, count: r.pullRequests, evidence: r.evidence, summary: `${r.withChanges} of ${r.pullRequests} pull requests in ${r.repo} (${Math.round(r.share * 100)}%) got changes requested in ${days} days.`, detail: { withChanges: r.withChanges } });
  }
  for (const f of result.flakyCi) {
    if (f.pairs >= THRESHOLDS.flakyCiPairs)
      out.push({ type: 'flakyCi', scope: f.repo, key: `flakyCi:${f.repo}`, value: f.pairs, unit: 'count', threshold: THRESHOLDS.flakyCiPairs, count: f.commits, evidence: f.evidence.slice(0, MAX_EVIDENCE), summary: `CI in ${f.repo} failed and then passed on the same commit ${f.pairs} times in ${days} days.`, detail: { commits: f.commits } });
  }
  for (const t of result.toil) {
    if (t.repeats >= THRESHOLDS.toilRepeats)
      out.push({ type: 'toil', scope: t.phrase, key: `toil:${t.source}:${t.phrase}`, value: t.repeats, unit: 'count', threshold: THRESHOLDS.toilRepeats, count: t.repeats, evidence: t.evidence, summary: `“${t.phrase}” came up ${t.repeats} times in ${days} days (${t.source === 'work.session' ? 'work sessions' : 'Landflow usage'}).`, detail: { source: t.source } });
  }
  for (const h of result.handoffs) {
    if (h.pullRequests >= THRESHOLDS.handoffPullRequests)
      out.push({ type: 'handoffs', scope: h.repo, key: `handoffs:${h.repo}`, value: h.pullRequests, unit: 'count', threshold: THRESHOLDS.handoffPullRequests, count: h.rounds, evidence: h.evidence, summary: `${h.pullRequests} pull requests in ${h.repo} went back and forth in ${THRESHOLDS.handoffRounds} or more review rounds in ${days} days.`, detail: { rounds: h.rounds } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// One flow idea per signal
// ---------------------------------------------------------------------------

export interface FlowIdea {
  title: string;
  why: string;
  effect: string;
  buildPrompt: string;
}

/**
 * The idea used when the brain has no model (or its answer did not fit): one per signal type, built from the signal's own
 * numbers. The build prompt is what Spotlight is asked to build, so it names real nodes and what each step does.
 */
export function deterministicIdea(signal: Signal): FlowIdea {
  const where = signal.type === 'toil' ? '' : ` in ${signal.scope}`;
  switch (signal.type) {
    case 'reviewWait':
      return {
        title: `Ping the reviewer when a PR waits over a day${where}`,
        why: signal.summary,
        effect: `Cut the median wait for a first review from ${signal.value} hours toward ${signal.threshold}.`,
        buildPrompt: `Build a workflow that runs every morning at 9: read the pull requests of ${signal.scope} that have waited more than 24 hours for a review (GitHub), and for each one post a short reminder to the team's Slack channel with the pull request link and how long it has waited. Skip drafts.`,
      };
    case 'cycleTime':
      return {
        title: `Flag pull requests that stay open too long${where}`,
        why: signal.summary,
        effect: `Bring the median time to merge from ${signal.value} hours toward ${signal.threshold}.`,
        buildPrompt: `Build a workflow that runs every day at 10: list the open pull requests of ${signal.scope} older than 3 days (GitHub), and post one Slack message with the list, oldest first, and the pull request links. Skip drafts.`,
      };
    case 'rework':
      return {
        title: `Post a short checklist on every new PR${where}`,
        why: signal.summary,
        effect: `Fewer pull requests that need a second round: today ${Math.round(signal.value * 100)}% do.`,
        buildPrompt: `Build a workflow that starts when a pull request is opened in ${signal.scope} (GitHub webhook) and comments on it with a short checklist: tests added, docs updated, description says why. Keep the comment to five lines.`,
      };
    case 'flakyCi':
      return {
        title: `Re-run flaky CI once and label it${where}`,
        why: signal.summary,
        effect: `Stop people re-running CI by hand: ${signal.value} reruns of the same commit in the window.`,
        buildPrompt: `Build a workflow that starts when a CI run fails in ${signal.scope} (GitHub webhook). Re-run the failed jobs once. If the second run passes, add the label "flaky-ci" to the pull request and record the test name in a data table; if it fails again, leave it for the author.`,
      };
    case 'toil':
      return {
        title: `Automate “${signal.scope}”`,
        why: signal.summary,
        effect: `Save the time spent on the same task ${signal.value} times in the window.`,
        buildPrompt: `Build a workflow for this repeated task: "${signal.scope}". It came up ${signal.value} times recently. Start from a webhook or a schedule that fits, do the steps a person did by hand, and post the result where the team looks.`,
      };
    case 'handoffs':
      return {
        title: `Nudge the author when review rounds pile up${where}`,
        why: signal.summary,
        effect: `Fewer pull requests with ${THRESHOLDS.handoffRounds} or more review rounds (${signal.value} now).`,
        buildPrompt: `Build a workflow that starts when a third review is left on a pull request in ${signal.scope} (GitHub webhook) and posts one Slack message suggesting a short call to settle what is open, with the pull request link. Do not name anyone.`,
      };
  }
}

const clip = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

/** Read a model's JSON answer as an idea; undefined when it lacks a title or a build prompt. */
export function ideaFromModel(text: string, signal: Signal): FlowIdea | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const title = clip(data.title, 120);
  const buildPrompt = clip(data.buildPrompt ?? data.build_prompt ?? data.prompt, 1_800);
  if (title.length < 6 || buildPrompt.length < 30) return undefined;
  return { title, why: clip(data.why, 400) ? `${clip(data.why, 400)} ${signal.summary}`.trim() : signal.summary, effect: clip(data.effect ?? data.expectedEffect, 300) || deterministicIdea(signal).effect, buildPrompt };
}

/** The prompt that asks the brain's model for one idea. It carries the signal only: numbers, a repository, a phrase. */
export function ideaPrompt(signal: Signal): string {
  return [
    'A company measures how fast its software moves. One measure is off:',
    signal.summary,
    '',
    'Propose ONE Landflow workflow that would raise velocity here. Landflow workflows run on triggers (schedule, webhook), call tools (GitHub, Slack, HTTP, AI) and post results to people. The workflow must be about the process, never about ranking or reporting on a person.',
    'Reply with JSON only: {"title": short name of the idea, "why": one sentence, "effect": the expected effect in words, "buildPrompt": 2 to 4 sentences telling an AI flow builder exactly what to build: the trigger, each step, and where the result goes}.',
  ].join('\n');
}
