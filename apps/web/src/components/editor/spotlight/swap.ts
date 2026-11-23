/**
 * What a reply's placeholder slot does: whether `StatusSwap` is mounted, whether it shows the Working line, and whether
 * that line stays silent because a trace or the build's steps already say it. A streamed reply keeps the slot mounted for
 * its whole live stretch, so the first words cross-fade in instead of popping (also in the builder chat, where the build's
 * steps are on screen).
 */
export function swapState(o: { live: boolean; streamed: boolean; hasSteps: boolean; own: boolean; hasWords: boolean; hasTrace: boolean }) {
  const working = o.live && !o.own && !o.hasWords;
  const mounted = o.streamed ? o.live || o.hasWords : working && !o.hasSteps;
  const silent = o.hasSteps || o.hasTrace;
  // The spinner mark keeps its own rule: it is off while the build's steps show their own.
  const spinner = working && !o.hasSteps;
  return { mounted, working, silent, spinner };
}
