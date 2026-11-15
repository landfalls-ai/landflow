/**
 * What the LiteLLM wave's parts tell each other inside one process (docs/llm-gateway.md), so no package imports another
 * package's module of the same wave:
 *
 * - `capsChanged(trigger, capIds?)`: a Landflow cap changed (Settings → AI usage caps saved, a cap raise approved, an
 *   agent's usage limits saved). The budgets sync (LL04) listens and mirrors the change to LiteLLM's budgets.
 * - `runtimeKeyChanged(agentId)`: a key for an agent on kagent was minted, moved or blocked (LL03). The sync listens and
 *   sets that key's budget.
 *
 * Listeners run after the caller's work, never throw into it, and are not awaited unless the caller asks
 * (`await capsChanged(…)` waits for every listener; a failure is logged and swallowed).
 *
 * Contract file of the LiteLLM wave (LL): every app package of the wave adds it byte for byte. Change it only through the
 * integrator.
 */
import { logger } from '../telemetry/logger';
import { singleton } from '../singleton';

export type CapsChangeTrigger = 'settings' | 'approval' | 'agent' | 'workflow';

type CapsListener = (trigger: CapsChangeTrigger, capIds: string[] | undefined) => void | Promise<void>;
type KeyListener = (agentId: string) => void | Promise<void>;

interface Listeners {
  caps: Set<CapsListener>;
  keys: Set<KeyListener>;
}

const listeners = () => singleton<Listeners>('llm-gateway-events', () => ({ caps: new Set(), keys: new Set() }));

async function each<T extends (...args: never[]) => void | Promise<void>>(set: Set<T>, call: (listener: T) => void | Promise<void>, what: string) {
  for (const listener of [...set]) {
    try {
      await call(listener);
    } catch (error) {
      logger.warn(`llm gateway: a ${what} listener failed`, { error: (error as Error).message });
    }
  }
}

/** Listen for cap changes; returns the function that stops listening. */
export function onCapsChanged(listener: CapsListener): () => void {
  listeners().caps.add(listener);
  return () => listeners().caps.delete(listener);
}

/** Say that caps changed (all of them when `capIds` is undefined). */
export function capsChanged(trigger: CapsChangeTrigger, capIds?: string[]): Promise<void> {
  return each(listeners().caps, (listener) => listener(trigger, capIds), 'caps');
}

/** Listen for runtime keys that were minted, moved or blocked; returns the function that stops listening. */
export function onRuntimeKeyChanged(listener: KeyListener): () => void {
  listeners().keys.add(listener);
  return () => listeners().keys.delete(listener);
}

/** Say that the runtime key of `agentId` changed. */
export function runtimeKeyChanged(agentId: string): Promise<void> {
  return each(listeners().keys, (listener) => listener(agentId), 'runtime key');
}
