/**
 * A hook between the usage meter and the cost alerts (./alerts.ts): the alert service, where one runs, asks to hear of
 * recorded model calls, and the meter tells it after each, so a check follows within a couple of seconds (one per burst).
 */
let scheduled: ReturnType<typeof setTimeout> | undefined;
let listener: (() => void) | undefined;

/** The alert service asks to hear of recorded model calls (to check soon after); undefined stops it. */
export function onUsageRecorded(run: (() => void) | undefined) {
  listener = run;
  if (!run && scheduled) {
    clearTimeout(scheduled);
    scheduled = undefined;
  }
}

/** The meter calls this after it stored a call. */
export function noteUsage() {
  if (!listener || scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = undefined;
    listener?.();
  }, 2_000);
  scheduled.unref?.();
}
