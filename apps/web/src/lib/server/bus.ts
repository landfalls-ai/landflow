import { EventEmitter } from 'node:events';
import type { ExecutionEvent } from '@landflow/engine';
import type { AgentStreamEvent } from '../shared/agents';
import type { RegistryEvent } from '../shared/types';
import { singleton } from './singleton';

export type BusEvent =
  | { channel: 'registry'; event: RegistryEvent }
  | { channel: 'execution'; workflowId: string; event: ExecutionEvent }
  | { channel: 'agent'; agentId: string; event: AgentStreamEvent };

/** In-process pub/sub feeding the /api/events SSE stream. */
export const bus = singleton('bus', () => {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(200);
  let seq = 0;
  return {
    publish(event: BusEvent) {
      emitter.emit('event', { ...event, seq: ++seq, at: new Date().toISOString() });
    },
    subscribe(listener: (event: BusEvent & { seq: number; at: string }) => void) {
      emitter.on('event', listener);
      return () => emitter.off('event', listener);
    },
  };
});
