import type { ExecutionEvent } from '@landflow/engine';
import type { AgentStreamEvent } from '../shared/agents';
import type { EditLockView } from '../shared/auth';
import type { JournalEvent } from '../shared/run-trace';
import type { RegistryEvent } from '../shared/types';
import { singleton } from './singleton';
import { logger } from './telemetry';

export type BusEvent =
  | { channel: 'registry'; event: RegistryEvent }
  | { channel: 'execution'; workflowId: string; event: ExecutionEvent }
  | { channel: 'agent'; agentId: string; event: AgentStreamEvent }
  /** New entries of an execution's journal (Run Trace, lib/server/journal), in seq order, batched about twice a second. */
  | {
      channel: 'journal';
      workflowId: string;
      executionId: string;
      events: JournalEvent[];
    }
  /** Someone opened, took over or left a workflow in the editor (lib/server/auth/edit-locks.ts); null = free. */
  | { channel: 'lock'; workflowId: string; lock: EditLockView | null };

/** Events another process published (queue mode relays them, lib/server/cluster/relay.ts). */
const RELAYED = Symbol.for('landflow.bus.relayed');

/** Whether a bus event came from another process: listeners that act on events (not just show them) skip those. */
export const isRelayed = (event: object) => RELAYED in event;

/** Queue mode: where this process's events go to the others (set by the cluster runtime). */
const outbound = singleton('bus-outbound', () => ({
  send: undefined as ((event: BusEvent) => void) | undefined,
}));

export function setBusRelay(send: ((event: BusEvent) => void) | undefined) {
  outbound.send = send;
}

export type SeqEvent = BusEvent & { seq: number; at: string };

/** How many recent events a reconnecting /api/events client can be caught up from. */
export const REPLAY_RING_SIZE = 500;

/**
 * In-process pub/sub feeding the /api/events SSE stream (queue mode: also fed by the other processes). `seq` counts
 * this process's events only; `bootId` tells a client's `Last-Event-ID` from this process apart from one issued by
 * another process or an earlier run of this one, whose numbers mean nothing here.
 */
export const bus = singleton('bus', () => {
  const listeners = new Set<(event: SeqEvent) => void>();
  const ring: SeqEvent[] = [];
  const bootId = Math.random().toString(36).slice(2, 8);
  let seq = 0;
  const emit = (event: SeqEvent) => {
    ring.push(event);
    if (ring.length > REPLAY_RING_SIZE) ring.shift();
    // One throwing listener must not keep the others from seeing the event or break the publisher.
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (caught) {
        logger.debug('bus listener threw', { error: caught });
      }
    }
  };
  return {
    bootId,
    publish(event: BusEvent) {
      emit({ ...event, seq: ++seq, at: new Date().toISOString() });
      outbound.send?.(event);
    },
    /** An event another process published: shown here, never sent back. */
    publishRelayed(event: BusEvent) {
      emit(Object.defineProperty({ ...event, seq: ++seq, at: new Date().toISOString() }, RELAYED, { value: true }));
    },
    /**
     * `afterSeq`: first deliver the retained events newer than it (check `covers` first: the ring may have moved on).
     */
    subscribe(listener: (event: SeqEvent) => void, options: { afterSeq?: number } = {}) {
      if (options.afterSeq !== undefined) for (const event of ring) if (event.seq > options.afterSeq) listener(event);
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Whether the ring still holds every event after `afterSeq` (it does when nothing was dropped past it). */
    covers(afterSeq: number) {
      return afterSeq <= seq && (ring.length === 0 ? afterSeq === seq : afterSeq >= ring[0].seq - 1);
    },
  };
});
