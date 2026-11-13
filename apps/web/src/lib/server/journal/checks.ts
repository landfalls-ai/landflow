/**
 * A person's decision on a failed check (`POST /api/executions/:id/checks`): written to the journal as a check event
 * with `resolution`, so the run's report and the needs-you list stop counting it.
 */
import type { JournalEvent, RunCheck } from '../../shared/run-trace';
import { promoteExecution } from '../db/reads';
import { journalOf, liveJournal, releaseJournal } from './writer';
import { readEventsAsync } from './store';
import { HttpError } from '../errors';

export interface CheckDecision {
  spanId: string;
  name: string;
  /** Which of the span's checks of that name (a team's Budget for each member); any of them when absent. */
  subject?: string;
  decision: 'accepted' | 'sent_back';
  note?: string;
}

export class CheckError extends HttpError {
  constructor(
    message: string,
    status: number,
  ) {
    super(message, status, { expose: true });
  }
}

/** The latest check event named `name` in `spanId` (about `subject`, when given), found by reading the execution's journal. */
async function latestCheck(executionId: string, spanId: string, name: string, subject?: string): Promise<Extract<JournalEvent, { type: 'check' }> | undefined> {
  let found: Extract<JournalEvent, { type: 'check' }> | undefined;
  for (let after = 0; ; ) {
    const page = await readEventsAsync(executionId, after, 1000);
    for (const event of page) {
      if (event.type === 'check' && event.spanId === spanId && event.check.name === name && (subject === undefined || event.check.subject === subject)) found = event;
    }
    if (page.length < 1000) return found;
    after = page[page.length - 1].seq;
  }
}

/**
 * Write the decision. Returns the stored check. The run may be an old one (Postgres mode keeps a finished run's journal
 * out of the in-memory copy): it is loaded back first, so the new event is numbered after the stored ones.
 */
export async function resolveCheck(executionId: string, workflowId: string, input: CheckDecision, by: string): Promise<RunCheck> {
  await promoteExecution(executionId);
  const original = await latestCheck(executionId, input.spanId, input.name, input.subject);
  if (!original) throw new CheckError('No such check in that span', 404);
  if (original.check.resolution) throw new CheckError('Already settled', 409);
  if (original.check.status !== 'fail') throw new CheckError('Only a failed check needs a decision', 409);
  // The check keeps who made it (a node, the Run report); `resolution` says a person settled it.
  const check: RunCheck = { ...original.check, resolution: { decision: input.decision, by, ...(input.note && { note: input.note }) } };
  // A running segment's journal takes the event; otherwise one is opened for this write and let go.
  const running = liveJournal(executionId);
  const journal = running ?? journalOf(executionId, { workflowId });
  journal.record({ type: 'check', spanId: input.spanId, check });
  journal.flush();
  if (!running) releaseJournal(executionId);
  return check;
}
