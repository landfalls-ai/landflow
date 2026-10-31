/**
 * The journal writer: numbers the events of one execution, applies the content mode and redaction, batches the writes
 * (about twice a second, at once when the run ends or starts waiting) and publishes each stored batch on the bus as the
 * `journal` channel. A failure to write is logged and never fails the run (like saveProgress in runner.ts).
 */
import type { JournalDraft, JournalEvent, RunActor, TraceContent } from '../../shared/run-trace';
import { bus } from '../bus';
import { redactRunData } from '../secrets/runtime';
import { singleton } from '../singleton';
import { logger } from '../telemetry';
import { applyContent, contentOf } from './content';
import { append, lastSeq, SeqClash } from './store';

const FLUSH_MS = 500;
const CLASH_RETRIES = 5;

export interface JournalOptions {
  workflowId: string;
  /** The workflow's `traceContent` setting; absent: LANDFLOW_TRACE_CONTENT, default full. */
  content?: TraceContent;
}

export class Journal {
  /** The run's OTel trace, stamped on events written after it is known. */
  traceId?: string;
  private seq: number | undefined;
  private pending: JournalEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private nodeSpan: ((nodeId: string) => string | undefined) | undefined;
  private nodeActor: ((nodeId: string) => RunActor | undefined) | undefined;

  constructor(
    readonly executionId: string,
    private options: JournalOptions,
  ) {}

  configure(options: JournalOptions) {
    this.options = options;
  }

  /** Where `spanOfNode` looks (the translator of the running segment). */
  bindSpans(spanOfNode: ((nodeId: string) => string | undefined) | undefined, actorOfNode?: (nodeId: string) => RunActor | undefined) {
    this.nodeSpan = spanOfNode;
    this.nodeActor = actorOfNode;
  }

  /** The span of a node of this run: its open one, else its latest. Other writers (a Landflow agent's session) put their events under it. */
  spanOfNode(nodeId: string): string | undefined {
    return this.nodeSpan?.(nodeId);
  }

  /** Who a node of this run acts as (its span's actor): an agent's session in a flow speaks as its node. */
  actorOfNode(nodeId: string): RunActor | undefined {
    return this.nodeActor?.(nodeId);
  }

  /**
   * Add an event. `redacted`: it was built from data the runner already redacted (the engine's events); anything else
   * goes through the same redaction here.
   */
  record(draft: JournalDraft, options: { redacted?: boolean } = {}) {
    try {
      this.seq ??= lastSeq(this.executionId);
      const base = { ...draft, seq: this.seq + 1, executionId: this.executionId, at: draft.at ?? new Date().toISOString(), ...(this.traceId && !draft.traceId && { traceId: this.traceId }) } as JournalEvent;
      const event = applyContent(options.redacted ? base : redactRunData(base), contentOf(this.options.content));
      this.seq++;
      this.pending.push(event);
      if (!this.timer) {
        this.timer = setTimeout(() => this.flush(), FLUSH_MS);
        this.timer.unref?.();
      }
    } catch (error) {
      logger.warn('could not journal an event', { error: (error as Error).message, 'landflow.execution.id': this.executionId });
    }
  }

  /** Store what is waiting and tell the live stream. */
  flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.pending;
    this.pending = [];
    if (!batch.length) return;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          append(this.executionId, batch);
          break;
        } catch (error) {
          if (!(error instanceof SeqClash) || attempt >= CLASH_RETRIES) throw error;
          // Another process wrote to this execution (a resumed run's worker): number again from what is stored.
          let next = lastSeq(this.executionId);
          for (const event of batch) event.seq = ++next;
          this.seq = next;
        }
      }
    } catch (error) {
      logger.warn('could not store the run journal', { error: (error as Error).message, 'landflow.execution.id': this.executionId });
      return;
    }
    bus.publish({ channel: 'journal', workflowId: this.options.workflowId, executionId: this.executionId, events: batch });
  }
}

const journals = singleton('run-journals', () => new Map<string, Journal>());

/** The journal of a running execution (created on first use; writers of one execution share it). */
export function journalOf(executionId: string, options: JournalOptions): Journal {
  let journal = journals.get(executionId);
  if (!journal) journals.set(executionId, (journal = new Journal(executionId, options)));
  else journal.configure(options);
  return journal;
}

/** The journal of an execution that is running in this process, for writers that put events under a node's span. */
export function liveJournal(executionId: string): Journal | undefined {
  return journals.get(executionId);
}

/** Flush and forget an execution's journal (its segment ended). */
export function releaseJournal(executionId: string) {
  const journal = journals.get(executionId);
  journal?.flush();
  journals.delete(executionId);
}

/** Flush every journal and forget them (tests). */
export function resetJournals() {
  for (const id of [...journals.keys()]) releaseJournal(id);
}
