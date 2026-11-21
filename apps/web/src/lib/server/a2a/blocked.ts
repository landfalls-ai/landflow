/**
 * Blocked on the A2A path (C05): a remote task that fails because the provider's quota or credits ran out is not an
 * ordinary failure. `blockedOf` reads a failed task's status message (data parts and text) and metadata through the
 * shared classifier; `ProviderBlockedError` carries the answer through an agent's tool call; `countBlocked` counts each
 * entry as `landflow.harness.blocked{kind, harness}` (own meter scope like audit/metrics.ts, re-created when the global
 * meter provider changes, with an in-process tally so tests and a metrics view need no exporter).
 */
import { metrics, type Counter, type MeterProvider } from '@opentelemetry/api';
import { NodeOperationError } from '@landflow/sdk';
import { BLOCKED_LABEL, classifyRecord, classifyText, type BlockedKind, type BlockVerdict } from '../../shared/quota-block';
import { singleton } from '../singleton';
import { telemetryConfig } from '../telemetry/config';
import type { A2aTask } from './client';

/** Thrown by an agent's A2A tool when the remote task was Blocked; a plain Error, it never answers an HTTP request. */
export class ProviderBlockedError extends Error {
  readonly kind: BlockedKind;
  readonly providerMessage: string;
  constructor(agent: string, kind: BlockedKind, providerMessage: string) {
    super(`${agent}: ${BLOCKED_LABEL[kind]}${providerMessage && providerMessage !== BLOCKED_LABEL[kind] ? `: ${providerMessage}` : ''}`);
    this.name = 'ProviderBlockedError';
    this.kind = kind;
    this.providerMessage = providerMessage;
  }
}

/** What the A2A node throws for a Blocked task: a user-facing node error that also says which limit it was (the catch reads `kind`). */
export class BlockedNodeError extends NodeOperationError {
  readonly kind: BlockedKind;
  constructor(agent: string, kind: BlockedKind, providerMessage: string, itemIndex: number) {
    super(`${agent}: ${BLOCKED_LABEL[kind]}`, { description: providerMessage, itemIndex });
    this.name = 'BlockedNodeError';
    this.kind = kind;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether a failed task stopped on a provider limit: its status data and metadata first (the field is exact), then its words. */
export function blockedOf(task: A2aTask): BlockVerdict {
  if (task.status.state !== 'TASK_STATE_FAILED') return { blocked: false };
  const parts = task.status.message?.parts ?? [];
  const shapes: unknown[] = [...parts.map((part) => part.data), task.metadata?.error, task.status.message?.metadata?.error, task.metadata].filter(isObject);
  for (const shape of shapes) {
    const verdict = classifyRecord(shape);
    if (verdict.blocked) return verdict;
  }
  const text = parts.flatMap((part) => (typeof part.text === 'string' ? [part.text] : [])).join('\n');
  const dataText = parts.flatMap((part) => (isObject(part.data) && typeof part.data.message === 'string' ? [part.data.message] : [])).join('\n');
  const words = classifyText(text);
  return words.blocked ? words : classifyText(dataText);
}

// ---- the counter ----------------------------------------------------------

const SCOPE = 'landflow-harness';
const cache = () => singleton('harness-blocked-counter', () => ({ current: undefined as { provider: MeterProvider; counter: Counter } | undefined }));
const tally = () => singleton('harness-blocked-tally', () => new Map<string, number>());

function counter(): Counter {
  const provider = metrics.getMeterProvider();
  const held = cache();
  if (held.current?.provider === provider) return held.current.counter;
  const created = provider.getMeter(SCOPE, telemetryConfig.serviceVersion).createCounter('landflow.harness.blocked', { description: 'Entries into Blocked (a provider limit stopped a turn), by kind and harness' });
  held.current = { provider, counter: created };
  return created;
}

/** One entry into Blocked. `harness` is a small fixed set (`a2a` here, `codex` for the CLI watch), never an agent's name. */
export function countBlocked(kind: BlockedKind, harness: string): void {
  const key = `${kind}\u0000${harness}`;
  const map = tally();
  map.set(key, (map.get(key) ?? 0) + 1);
  try {
    counter().add(1, { kind, harness });
  } catch {
    // Metrics never break a run.
  }
}

export function blockedCounts(): Array<{ kind: BlockedKind; harness: string; count: number }> {
  return [...tally()].map(([key, count]) => {
    const [kind, harness] = key.split('\u0000');
    return { kind: kind as BlockedKind, harness, count };
  });
}
