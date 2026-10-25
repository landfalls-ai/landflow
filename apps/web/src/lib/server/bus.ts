import { EventEmitter } from 'node:events';
import type { ExecutionEvent } from '@landflow/engine';
import type { AgentStreamEvent } from '../shared/agents';
import type { EditLockView } from '../shared/auth';
import type { RegistryEvent } from '../shared/types';
import { singleton } from './singleton';

export type BusEvent =
  | { channel: 'registry'; event: RegistryEvent }
  | { channel: 'execution'; workflowId: string; event: ExecutionEvent }
  | { channel: 'agent'; agentId: string; event: AgentStreamEvent }
  /** Someone opened, took over or left a workflow in the editor (lib/server/auth/edit-locks.ts); null = free. */
  | { channel: 'lock'; workflowId: string; lock: EditLockView | null };

/** Events another process published (queue mode relays them, lib/server/cluster/relay.ts). */
const RELAYED = Symbol.for('landflow.bus.relayed');

/** Whether a bus event came from another process: listeners that act on events (not just show them) skip those. */
export const isRelayed = (event: object) => RELAYED in event;

/** Queue mode: where this process's events go to the others (set by the cluster runtime). */
const outbound = singleton('bus-outbound', () => ({ send: undefined as ((event: BusEvent) => void) | undefined }));

export function setBusRelay(send: ((event: BusEvent) => void) | undefined) {
  outbound.send = send;
}

/** In-process pub/sub feeding the /api/events SSE stream (queue mode: also fed by the other processes). */
export const bus = singleton('bus', () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);
  let seq = 0;
  return {
    publish(event: BusEvent) {
      emitter.emit('event', { ...event, seq: ++seq, at: new Date().toISOString() });
      outbound.send?.(event);
    },
    /** An event another process published: shown here, never sent back. */
    publishRelayed(event: BusEvent) {
      emitter.emit('event', Object.defineProperty({ ...event, seq: ++seq, at: new Date().toISOString() }, RELAYED, { value: true }));
    },
    subscribe(listener: (event: BusEvent & { seq: number; at: string }) => void) {
      emitter.on('event', listener);
      return () => emitter.off('event', listener);
    },
  };
});
