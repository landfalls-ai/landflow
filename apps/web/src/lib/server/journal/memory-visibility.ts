/**
 * Who may read `saw.memoryText` (C09): the exact memory block of a run is a person's private memory, so a journal read keeps it for that
 * person, the agent's editors and instance admins, and takes it (and who it was for) out for anyone else who can read the run.
 * The sources (ids, versions, scores) stay: they hold no words.
 */
import type { JournalEvent } from '../../shared/run-trace';
import { canResource, isInstanceAdmin, type Actor } from '../projects/access';

/** The events with memory text kept only where `actor` may read it. A copy of what it changes. */
export function hideMemoryText<E extends Pick<JournalEvent, 'type'>>(events: readonly E[], actor: Actor | undefined): E[] {
  return events.map((event) => {
    const attrs = (event as unknown as { attrs?: { saw?: Record<string, unknown> } }).attrs;
    const saw = attrs?.saw;
    if (!saw || (saw.memoryText === undefined && saw.memoryFor === undefined)) return event;
    const allowed =
      Boolean(actor) &&
      (isInstanceAdmin(actor) || saw.memoryFor === actor!.id || (typeof saw.memoryAgent === 'string' && canResource(actor!, 'agent', saw.memoryAgent, 'update')));
    const { memoryText: _text, memoryFor: _for, memoryAgent: _agent, ...rest } = saw;
    return { ...event, attrs: { ...attrs, saw: allowed ? saw : rest } } as E;
  });
}
