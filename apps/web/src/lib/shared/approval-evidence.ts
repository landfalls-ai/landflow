/**
 * What an approval looked at (docs/run-trace.md#an-approval-with-its-evidence): the evidence the run already records about
 * the member that asks, one row per kind and only where there is data: checks, tests, code changes, fix cycles, its budget,
 * the run's time and when it asked. Each row says where it lives in the Run Trace (a detail sheet, or a tab). Pure.
 */
import { teamSnapshotOf } from './agent-teams';
import { fixCyclesOf } from './fix-cycles';
import { headlinesOf } from './run-headlines';
import type { RunChanges } from './run-changes';
import type { RunProfile } from './run-profiles';
import type { RunActor } from './run-trace';
import { cut, fmtMs, type NeedsYouItem, type RunModel } from './run-trace-model';
import type { ApprovalWait } from './approval-case';

export type EvidenceTone = 'ok' | 'bad' | 'warn' | '';

/** Where a row leads in the Run Trace: a detail sheet (the existing open mechanism), or a tab (`?tab=story&member=…`). */
export type EvidenceLink = { open: { kind: 'span' | 'artifact' | 'check' | 'actor'; id: string } } | { tab: 'story' | 'trace' | 'team' | 'artifacts' | 'report'; member?: string };

export interface EvidenceRow {
  id: 'asked' | 'checks' | 'tests' | 'changes' | 'rounds' | 'budget' | 'time';
  label: string;
  detail: string;
  tone: EvidenceTone;
  link?: EvidenceLink;
}

const same = (a: string | undefined, b: string | undefined) => Boolean(a && b) && a!.trim().toLowerCase() === b!.trim().toLowerCase();
const tokensText = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "asked 2m ago": the time since the wait began. */
export function askedAgo(since: string, now: number): string | undefined {
  const t = Date.parse(since);
  if (!t) return undefined;
  const ms = Math.max(0, now - t);
  return ms < 45_000 ? 'just now' : `${fmtMs(ms)} ago`;
}

/**
 * The evidence for a wait, in the order a person weighs it: when it asked, the member's checks and tests, what it changed,
 * how many fix cycles it went through, its budget and the run's time. `changes` (foldChanges of the journal) and `profile`
 * (the run's, which names the checks) are optional: without them those rows are left out.
 */
export function approvalEvidence(model: RunModel, wait: ApprovalWait, options: { now?: number; changes?: RunChanges; profile?: RunProfile } = {}): EvidenceRow[] {
  const now = options.now ?? model.foldedAt;
  const member = typeof wait.attrs.member === 'string' ? wait.attrs.member : undefined;
  const stats = member ? model.actors.find((a) => same(a.actor.name, member)) : undefined;
  const rows: EvidenceRow[] = [];

  const ago = askedAgo(wait.since, now);
  if (ago) rows.push({ id: 'asked', label: 'Asked', detail: ago === 'just now' ? 'just now' : ago, tone: '', link: { open: { kind: 'span', id: wait.spanId } } });

  // Checks: the member's latest result of each, newest word wins.
  const latest = new Map<string, (typeof model.checks)[number]>();
  for (const item of model.checks) {
    if (!member || (!same(item.check.subject, member) && !same(item.actor?.name, member))) continue;
    const key = item.check.name;
    const known = latest.get(key);
    if (!known || known.seq < item.seq) latest.set(key, item);
  }
  // The approval's own check is a decision, not evidence.
  const checks = [...latest.values()].filter((c) => c.check.name !== 'Approval');
  if (checks.length) {
    const failed = checks.filter((c) => c.check.status === 'fail');
    const warned = checks.filter((c) => c.check.status === 'warn');
    const passed = checks.filter((c) => c.check.status === 'pass');
    const parts = [passed.length && `${passed.length} passed`, failed.length && `${failed.length} failed (${failed.map((c) => c.check.name).slice(0, 2).join(', ')})`, warned.length && `${warned.length} to look at`].filter(Boolean);
    const first = failed[0] ?? warned[0] ?? checks[0];
    rows.push({ id: 'checks', label: 'Checks', detail: parts.join(' · '), tone: failed.length ? 'bad' : warned.length ? 'warn' : 'ok', link: { open: { kind: 'check', id: first.id } } });
  }

  // Tests and the like, from the moments the team kept ("14 tests pass").
  if (member) {
    const moments = headlinesOf(model).filter((h) => same(h.moment.member, member) && /\b(tests?|typecheck|lint|build)\b/i.test(h.moment.text));
    const last = moments.at(-1);
    if (last) rows.push({ id: 'tests', label: 'Tests', detail: cut(last.moment.text, 60), tone: last.moment.tone === 'ok' ? 'ok' : last.moment.tone === 'bad' ? 'bad' : last.moment.tone === 'warn' ? 'warn' : '', link: { tab: 'story', member } });
  }

  // Code changes: +/- and files of what the member wrote.
  const changes = options.changes;
  if (changes?.files.length) {
    const mine = member ? changes.files.filter((f) => f.actors.some((a) => same(a.actor.name, member))) : changes.files;
    if (mine.length) {
      const add = mine.reduce((n, f) => n + f.additions, 0);
      const del = mine.reduce((n, f) => n + f.deletions, 0);
      rows.push({ id: 'changes', label: 'Changes', detail: `+${add} −${del} in ${plural(mine.length, 'file')}`, tone: '', link: { tab: 'artifacts' } });
    }
  }

  // Review rounds: the fix cycles of the member's checks.
  if (options.profile && member) {
    const cycles = fixCyclesOf(model, options.profile).filter((c) => same(c.actor.name, member));
    if (cycles.length) {
      const worst = cycles.find((c) => !c.passed) ?? cycles[0];
      const runs = cycles.reduce((n, c) => n + c.runs.length, 0);
      rows.push({ id: 'rounds', label: 'Fix cycles', detail: cycles.length === 1 ? worst.trend : `${plural(runs, 'check run')} · ${cycles.map((c) => c.trend).join('; ')}`, tone: cycles.some((c) => !c.passed) ? 'bad' : 'ok', link: { open: { kind: 'span', id: worst.runs[worst.runs.length - 1].spanId } } });
    }
  }

  // Budget used against the member's own.
  if (member && stats) {
    const budget = model.order.map((s) => teamSnapshotOf(s.attrs)).find(Boolean)?.members.find((m) => same(m.title, member))?.budgetTokens;
    const used = stats.tokensIn + stats.tokensOut;
    if (budget && used > 0) {
      const share = used / budget;
      rows.push({ id: 'budget', label: 'Budget', detail: `${tokensText(used)} of ${tokensText(budget)} tokens (${Math.round(share * 100)}%)`, tone: share >= 1 ? 'bad' : share >= 0.8 ? 'warn' : '', link: { tab: 'team', member } });
    }
  }

  // Time: the run's, and the member's own work in it.
  const runMs = Math.max(0, (model.live ? now : model.t1) - model.t0);
  if (model.t0 && runMs > 0) {
    const work = stats && stats.workMs > 0 ? ` · ${member} worked ${fmtMs(stats.workMs)}` : '';
    rows.push({ id: 'time', label: 'Run time', detail: `${fmtMs(runMs)} so far${work}`, tone: '', link: { tab: 'story' } });
  }
  return rows;
}

/** One face in the row across the top of Needs you: a member, with a dot when it waits for the person. */
export interface NeedFace {
  name: string;
  actor: RunActor;
  waiting: boolean;
  /** How many things of this member wait. */
  count: number;
}

const keyOf = (name: string) => name.trim().toLowerCase();
/** The member a wait is for: a team member's tool or a guard's ask names it. */
const memberOf = (item: NeedsYouItem): string | undefined => (item.kind === 'wait' && typeof item.attrs.member === 'string' ? item.attrs.member : undefined);

/**
 * Who has something for you: the team's members as faces, a dot on each that waits. A run without a team shows the members
 * that wait. Fewer than two faces make no row (the card already shows who asks).
 */
export function needsFaces(model: RunModel, items: NeedsYouItem[]): NeedFace[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const name = memberOf(item);
    if (name) counts.set(keyOf(name), (counts.get(keyOf(name)) ?? 0) + 1);
  }
  const actorOf = (name: string, id: string): RunActor => model.actors.find((a) => same(a.actor.name, name))?.actor ?? { id: `member:${id}`, name, type: 'agent' };
  const roster = model.order.map((s) => teamSnapshotOf(s.attrs)).find(Boolean)?.members.filter((m) => m.kind === 'agent') ?? [];
  const faces: NeedFace[] = roster.map((m) => ({ name: m.title, actor: actorOf(m.title, m.id), waiting: counts.has(keyOf(m.title)), count: counts.get(keyOf(m.title)) ?? 0 }));
  const known = new Set(faces.map((f) => keyOf(f.name)));
  for (const item of items) {
    const name = memberOf(item);
    if (name && !known.has(keyOf(name))) {
      known.add(keyOf(name));
      faces.push({ name, actor: actorOf(name, name), waiting: true, count: counts.get(keyOf(name)) ?? 1 });
    }
  }
  // Those who wait first.
  faces.sort((a, b) => Number(b.waiting) - Number(a.waiting));
  return faces.length >= 2 && faces.some((f) => f.waiting) ? faces : [];
}

/** The same across runs (the Executions page): one face per member or node that waits, with how many things it has for you. */
export function listFaces(rows: Array<{ member?: string; actor?: RunActor }>): NeedFace[] {
  const faces = new Map<string, NeedFace>();
  for (const row of rows) {
    const name = row.member ?? row.actor?.name;
    if (!name) continue;
    const known = faces.get(keyOf(name));
    if (known) known.count++;
    else faces.set(keyOf(name), { name, actor: row.member ? { id: `member:${name}`, name, type: 'agent' } : row.actor!, waiting: true, count: 1 });
  }
  return [...faces.values()];
}
