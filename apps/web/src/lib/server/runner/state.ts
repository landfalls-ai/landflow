/**
 * The runner's process-wide state: live executions, the debugger session, node progress, the queue waiters and the
 * children that finished before their parent waited. Everything else in runner/ reads and writes these maps.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import { context } from '@opentelemetry/api';
import type { DebugCommand, DebugController, ExecutionEvent, PauseInfo } from '@landflow/engine';
import type { ExecutionRecord, PausedState } from '../../shared/types';
import { bus, isRelayed } from '../bus';
import { singleton } from '../singleton';
import { publicUrl as configPublicUrl } from '../config';
import { resumeSignature, resumeSignatureMode } from '../resume-signing';
import type { RunReply, RunOptions } from './types';

/** Holds a paused run until someone sends continue, step or stop. */
export class DebugSession implements DebugController {
  readonly stepping: boolean;
  paused?: PausedState;
  private points: Set<string>;
  private waiter?: (command: DebugCommand) => void;

  constructor(options: NonNullable<RunOptions['debug']>) {
    this.stepping = Boolean(options.step);
    this.points = new Set(options.breakpoints ?? []);
  }

  breakpoints() {
    return this.points;
  }

  setBreakpoints(ids: string[]) {
    this.points = new Set(ids);
  }

  pause(info: PauseInfo) {
    this.paused = { nodeId: info.nodeId, nodeName: info.nodeName, reason: info.reason, since: new Date().toISOString() };
    return new Promise<DebugCommand>((resolve) => (this.waiter = resolve));
  }

  command(command: DebugCommand): boolean {
    const waiter = this.waiter;
    if (!waiter) return false;
    this.waiter = undefined;
    this.paused = undefined;
    waiter(command);
    return true;
  }
}

interface LiveExecution {
  controller: AbortController;
  debug?: DebugSession;
  record: ExecutionRecord;
  onReply?: (reply: RunReply) => void;
  replied?: boolean;
  /** Counts against its workflow's concurrency limit. */
  limited?: boolean;
}

export const live = singleton('live-executions', () => new Map<string, LiveExecution>());
/** Callers of queued runs in this process: settled when the run finishes (or is canceled). */
interface QueueWaiter {
  resolve: (record: ExecutionRecord) => void;
  reject: (error: unknown) => void;
  /** The trace context of the trigger call that queued it. */
  context: ReturnType<typeof context.active>;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void;
  onReply?: (reply: RunReply) => void;
}
/**
 * The latest `node.progress` of each running node, by execution (what a page opened mid-run reads), with `since`: when
 * the node first reported (a tool sub-node has no node.started to time it from). This process's runs, and in queue mode
 * every worker's, whose events reach each main over the bus relay.
 */
export type NodeProgress = Extract<ExecutionEvent, { type: 'node.progress' }> & { since: string };
const progressOf = singleton('node-progress', () => new Map<string, Map<string, NodeProgress>>());

/** Keep a run's live progress from its events: the latest per node, gone when the node or the run finishes. */
export function trackProgress(event: ExecutionEvent, executionId: string = event.executionId) {
  if (event.type === 'node.progress') {
    let nodes = progressOf.get(executionId);
    if (!nodes) progressOf.set(executionId, (nodes = new Map()));
    nodes.set(event.nodeId, { ...event, since: nodes.get(event.nodeId)?.since ?? event.at });
  } else if (event.type === 'node.finished') progressOf.get(executionId)?.delete(event.nodeId);
  else if (event.type === 'execution.finished') progressOf.delete(executionId);
}

// Queue mode: a worker's progress, relayed to this main, is kept like a run of its own.
singleton('node-progress-relayed', () => bus.subscribe((e) => e.channel === 'execution' && isRelayed(e) && trackProgress(e.event)));

/** What the running nodes of an execution last reported (ctx.sendProgress), by node id. */
export function liveProgress(executionId: string): Record<string, NodeProgress> {
  return Object.fromEntries(progressOf.get(executionId) ?? []);
}

export const queueWaiters = singleton('queue-waiters', () => new Map<string, QueueWaiter>());
/** Sub-executions that finished while their parent was still on its way into `waiting` for them. */
export const finishedChildren = singleton('finished-children', () => new Map<string, ExecutionRecord>());

/** Base of the links the host hands out (resume URLs, error workflow links): LANDFLOW_PUBLIC_URL, else localhost. */
export function publicUrl(): string {
  return configPublicUrl();
}

/** Where a webhook or form wait of an execution is resumed (`$execution.resumeUrl` / `resumeFormUrl`). */
export function resumeUrls(executionId: string) {
  // Signed when signatures are required; in development (optional) the URLs stay short and unsigned calls work.
  const sig = resumeSignatureMode() === 'required' ? `?sig=${resumeSignature(executionId)}` : '';
  return { webhook: `${publicUrl()}/api/waiting/${executionId}${sig}`, form: `${publicUrl()}/form/waiting/${executionId}${sig}` };
}
