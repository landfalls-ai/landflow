/** The next time a wake-up schedule fires: a plain function over the agent cron parser (docs/projects-and-goals.md#tasks). */
import { parseCron, timeParts } from '../agents/cron';

const MINUTE = 60_000;
const HORIZON_MS = 366 * 86_400_000;

/**
 * The first whole minute after `after` that a five-field cron fires, in `timeZone`; undefined when none falls within 366
 * days (`0 0 31 2 *`). Throws the parser's message for an expression it cannot read. Steps minute by minute, but skips
 * the rest of a day or hour that cannot match, so a schedule that never fires costs a few thousand steps.
 */
export function nextWake(cron: string, after: Date, timeZone: string): Date | undefined {
  const expression = cron.trim();
  const fields = expression.split(/\s+/);
  if (fields.length !== 5) throw new Error('A wake-up schedule has five fields');
  const full = parseCron(expression);
  const [, hour, dayOfMonth, month, dayOfWeek] = fields;
  const dayOnly = parseCron(`* * ${dayOfMonth} ${month} ${dayOfWeek}`);
  const hourOnly = parseCron(`* ${hour} * * *`);
  const end = after.getTime() + HORIZON_MS;
  for (let at = Math.floor(after.getTime() / MINUTE) * MINUTE + MINUTE; at <= end; ) {
    const parts = { ...timeParts(new Date(at), timeZone), second: 0 };
    if (!dayOnly.matches(parts)) {
      // Not a day it fires: jump toward the next midnight, an hour short so a clock change never skips its first hour.
      const toMidnight = (23 - parts.hour) * 60 + (59 - parts.minute) + 1;
      at += Math.max(1, toMidnight - 60) * MINUTE;
    } else if (!hourOnly.matches(parts)) {
      at += Math.max(1, 59 - parts.minute) * MINUTE;
    } else if (full.matches(parts)) {
      return new Date(at);
    } else {
      at += MINUTE;
    }
  }
  return undefined;
}
