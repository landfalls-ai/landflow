/**
 * A run's headlines (the Story tab's top row, docs/run-trace.md): the moments its team nodes kept on their output's
 * `activity` (tests pass, a review's verdict, a budget near its end, a question for a person), each placed in time and
 * on the story entry it scrolls to.
 */
import type { RunModel, StoryEntry } from './run-trace-model';
import { activityOf, type TeamMoment } from './team-progress';

export interface Headline {
  moment: TeamMoment;
  /** When it happened, epoch ms. */
  at: number;
  /** The story entry it scrolls to. */
  entryKey?: string;
}

const actorOf = (entry: StoryEntry) => ('span' in entry ? entry.span.actor : 'item' in entry ? entry.item.actor : 'from' in entry ? entry.from : undefined);
/** Moments worth a headline: results, verdicts, budgets and questions; not each hand-off. */
const headlineWorthy = (m: TeamMoment) => m.tone !== 'info' || / reported back$|^Branch pushed$|^Committed$|opened$/.test(m.text);

/** The moments the team nodes of a run kept (their output's `activity`), placed in time and on the story entry nearest them. */
export function headlinesOf(model: RunModel): Headline[] {
  const found: Headline[] = [];
  for (const span of model.order) {
    const activity = activityOf(span.output);
    if (!activity) continue;
    for (const m of activity.moments) if (headlineWorthy(m)) found.push({ moment: m, at: span.t0 + m.at });
  }
  found.sort((a, b) => a.at - b.at);
  const timed = model.story.map((entry) => ({ entry, at: Date.parse(entry.at) }));
  for (const h of found) {
    const before = timed.filter((t) => t.at <= h.at + 1500);
    // The member's own entry close before it (its answer, its failing step), else whatever the story says then.
    const own = [...before].reverse().find((t) => actorOf(t.entry)?.name.trim().toLowerCase() === h.moment.member.trim().toLowerCase() && h.at - t.at < 10 * 60_000);
    h.entryKey = (own ?? before.at(-1) ?? timed[0])?.entry.key;
  }
  return found;
}
