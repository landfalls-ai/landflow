/**
 * Trigger telemetry: `trigger.fire` (one per execution a trigger starts) and
 * `trigger.poll {type}` (one per poll of a polling trigger), with their metrics.
 */
import { context, type Context, type Span } from '@opentelemetry/api';
import type { NodeItem } from '@landflow/protocol';
import { hostMetrics } from './metrics';
import { failSpan, startSpan, traceparentHeader, withSpan } from './spans';

export type TriggerSource = 'manual' | 'webhook' | 'schedule' | 'poll' | 'chat' | 'form' | 'error' | 'mcp' | 'retry';

export interface TriggerInfo {
  source: TriggerSource;
  workflowId: string;
  /** The trigger node's name. */
  nodeName?: string;
}

export interface TriggerFire {
  span: Span;
  /** Run the execution inside this context so `workflow.execute` is a child of `trigger.fire`. */
  context: Context;
  /** `{ traceparent }` to return to an HTTP caller. */
  headers: Record<string, string>;
  end(error?: unknown): void;
}

/**
 * Start a `trigger.fire` span and count `landflow.trigger.fires`. Schedule, poll,
 * error-workflow and automatic-retry triggers start a new trace (linked to the poll's span, if any);
 * the others are children of the active (HTTP request) span. Call `end()` when the
 * execution has finished or been handed off.
 */
export function startTrigger(info: TriggerInfo): TriggerFire {
  hostMetrics().triggerFires.add(1, { 'landflow.workflow.id': info.workflowId, 'landflow.trigger.source': info.source });
  const { span, context: spanContext } = startSpan('trigger.fire', {
    root: info.source === 'schedule' || info.source === 'poll' || info.source === 'error' || info.source === 'retry',
    attributes: {
      'landflow.trigger.source': info.source,
      'landflow.workflow.id': info.workflowId,
      ...(info.nodeName && { 'landflow.node.name': info.nodeName }),
    },
  });
  let ended = false;
  return {
    span,
    context: spanContext,
    headers: traceparentHeader(spanContext),
    end(error) {
      if (ended) return;
      ended = true;
      if (error !== undefined) failSpan(span, error);
      span.end();
    },
  };
}

/** `startTrigger` around `run`: the execution runs inside `trigger.fire`, which ends when `run` settles. */
export async function fireTrigger<T>(info: TriggerInfo, run: (fire: TriggerFire) => Promise<T>): Promise<T> {
  const fire = startTrigger(info);
  try {
    const result = await context.with(fire.context, () => run(fire));
    fire.end();
    return result;
  } catch (error) {
    fire.end(error);
    throw error;
  }
}

export interface PollInfo {
  workflowId: string;
  nodeName: string;
  /** Qualified node type, e.g. "messaging.rssTrigger". */
  nodeType: string;
  /** The baseline poll (no pollState yet). */
  first: boolean;
}

/**
 * One poll of a polling trigger: a root `trigger.poll {type}` span around
 * `poll` (so its plugin.rpc Execute is a child), plus `landflow.poll.runs`
 * (`items` / `empty` / `error`) and `landflow.poll.duration`. `poll` returns the
 * new items; errors are recorded and rethrown.
 */
export async function tracePoll(info: PollInfo, poll: (span: Span) => Promise<NodeItem[]>): Promise<NodeItem[]> {
  const started = performance.now();
  const instruments = hostMetrics();
  const record = (result: 'items' | 'empty' | 'error') => {
    instruments.pollRuns.add(1, { 'landflow.node.type': info.nodeType, 'landflow.poll.result': result });
    instruments.pollDuration.record(performance.now() - started, { 'landflow.node.type': info.nodeType });
  };
  return withSpan(
    `trigger.poll ${info.nodeType}`,
    {
      root: true,
      attributes: {
        'landflow.workflow.id': info.workflowId,
        'landflow.node.name': info.nodeName,
        'landflow.node.type': info.nodeType,
        'landflow.poll.first': info.first,
      },
    },
    async (span) => {
      try {
        const items = await poll(span);
        span.setAttribute('landflow.poll.items', items.length);
        record(items.length ? 'items' : 'empty');
        return items;
      } catch (error) {
        record('error');
        throw error;
      }
    },
  );
}
