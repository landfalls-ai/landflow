/**
 * A person's word in a run: an approval or rejection written as a `message` in the wait span it answers.
 */
import type { RunActor } from '../../shared/run-trace';
import { spanEvents } from './store';
import { journalOf, liveJournal, releaseJournal } from './writer';

/** The execution's open wait span for the run itself (`run/wait:<n>`), the latest one. */
export function openWaitSpan(executionId: string): string | undefined {
  const waits: string[] = [];
  for (const event of spanEvents(executionId)) {
    if (event.type === 'span.started' && event.kind === 'wait' && event.parentSpanId === 'run') waits.push(event.spanId);
    else if (event.type === 'span.ended') {
      const at = waits.indexOf(event.spanId);
      if (at >= 0) waits.splice(at, 1);
    }
  }
  return waits.at(-1);
}

/** Say `text` as `person` in the open wait span of the execution. Never throws: the journal must not block a decision. */
export function recordDecision(executionId: string, workflowId: string, person: { id: string; name?: string }, text: string) {
  try {
    const spanId = openWaitSpan(executionId);
    if (!spanId) return;
    const from: RunActor = { id: `human:${person.id}`, name: person.name || 'A person', type: 'human' };
    const running = liveJournal(executionId);
    const journal = running ?? journalOf(executionId, { workflowId });
    journal.record({ type: 'message', spanId, from, text });
    journal.flush();
    if (!running) releaseJournal(executionId);
  } catch {
    // A journal write never decides a run.
  }
}
