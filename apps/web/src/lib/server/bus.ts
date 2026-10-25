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
