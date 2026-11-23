/** C22: when a source is next due. Pure, so the sync and the scheduler agree. */
import type { SourceSchedule } from '../../shared/knowledge-sources';

const EVERY: Record<SourceSchedule, number | undefined> = { manual: undefined, hourly: 3600_000, daily: 24 * 3600_000 };

/** The next time as ISO text, or null for a manual source. `sooner` (a sync cut short by a cap) wins over the schedule, scheduled or not. */
export function nextDue(schedule: string, now: number, sooner?: number): string | null {
  const every = EVERY[schedule as SourceSchedule];
  if (every === undefined) return sooner === undefined ? null : new Date(now + sooner).toISOString();
  return new Date(now + (sooner === undefined ? every : Math.min(sooner, every))).toISOString();
}
