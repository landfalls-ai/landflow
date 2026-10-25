/**
 * Messages between the processes of a cluster, over Valkey pub/sub:
 *
 * - `bus`: live events (executions, agents, edit locks) from every process, re-emitted on each main's bus so the
 *   editor's SSE stream (/api/events) shows runs going on any worker;
 * - `control`: cancel one execution, stop all, and the timers only the leader keeps (waits, retries, held trigger
 *   events) handed to it;
 * - `inbox:<instance>`: what a worker sends the main that waits for a run (its events, a webhook reply, the result);
 * - `changes`: tables another process wrote (SQLite on one host: caches drop what changed).
 *
 * Broadcast messages carry their origin, and a process ignores its own.
 */
import type { Coordinator } from './coordinator';
import { logger } from '../telemetry/logger';

export type RelayChannel = 'bus' | 'control' | 'changes';

export interface Envelope<T> {
  /** Origin instance. */
  o: string;
  m: T;
}

export class Relay {
  private readonly unsubscribers: Array<() => Promise<void>> = [];

  constructor(
    private readonly coordinator: Coordinator,
    readonly instanceId: string,
  ) {}

  /** Send to every other process listening on `channel`. */
  broadcast<T>(channel: RelayChannel, message: T): Promise<void> {
    return this.coordinator.publish(channel, JSON.stringify({ o: this.instanceId, m: message } satisfies Envelope<T>)).catch((error) => {
      logger.debug('cluster relay: publish failed', { 'landflow.cluster.channel': channel, error: (error as Error).message });
    });
  }

  /** Receive what other processes broadcast on `channel` (never this process's own messages). */
  async listen<T>(channel: RelayChannel, handler: (message: T, origin: string) => void): Promise<void> {
    const unsubscribe = await this.coordinator.subscribe(channel, (raw) => {
      let envelope: Envelope<T>;
      try {
        envelope = JSON.parse(raw) as Envelope<T>;
      } catch {
        return;
      }
      if (envelope.o === this.instanceId) return;
      try {
        handler(envelope.m, envelope.o);
      } catch (error) {
        logger.warn('cluster relay: handler failed', { 'landflow.cluster.channel': channel, error: (error as Error).message });
      }
    });
    this.unsubscribers.push(unsubscribe);
  }

  /** Send to one instance's inbox. */
  send<T>(instanceId: string, message: T): Promise<void> {
    return this.coordinator.publish(`inbox:${instanceId}`, JSON.stringify(message)).catch((error) => {
      logger.debug('cluster relay: inbox publish failed', { 'landflow.cluster.instance': instanceId, error: (error as Error).message });
    });
  }

  /** Receive this instance's inbox. */
  async receive<T>(handler: (message: T) => void): Promise<void> {
    const unsubscribe = await this.coordinator.subscribe(`inbox:${this.instanceId}`, (raw) => {
      try {
        handler(JSON.parse(raw) as T);
      } catch (error) {
        logger.warn('cluster relay: inbox handler failed', { error: (error as Error).message });
      }
    });
    this.unsubscribers.push(unsubscribe);
  }

  async close() {
    await Promise.allSettled(this.unsubscribers.splice(0).map((unsubscribe) => unsubscribe()));
  }
}
