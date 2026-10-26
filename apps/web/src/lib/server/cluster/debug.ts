/**
 * Queue mode: step debugging without sticky sessions. A debug session (a run started in debug mode from the editor)
 * stays in the main that started it, holding the paused run in memory; the editor's Continue, Step, Stop and
 * breakpoint changes may reach any main behind the load balancer. A main that doesn't hold the session asks the others
 * on the `control` channel; the one that does answers into the asker's inbox, so the route answers as if the session
 * were local. Each main also follows the other mains' `execution.paused` / `resumed` / `finished` events (the bus relay),
 * so the run it shows for a session held elsewhere says where it is paused.
 */
import { randomUUID } from 'node:crypto';
import type { DebugCommand, ExecutionEvent, PausedState } from '../../shared/types';
import { bus, isRelayed } from '../bus';
import { singleton } from '../singleton';
import { clusterActive, clusterState } from './state';

/** What `debugExecution` answers (lib/server/runner.ts). */
export type DebugAnswer = { ok: true; paused?: PausedState } | { ok: false; error: string; status: number };

export interface DebugRequest {
  command?: DebugCommand;
  breakpoints?: string[];
}

/** For another process: the asker waits for `debug-result` in its inbox. */
export interface DebugControl extends DebugRequest {
  t: 'debug';
  /** The execution. */
  id: string;
  /** Correlates the answer. */
  req: string;
  /** The asking instance (its inbox). */
  from: string;
}

export interface DebugResultMessage {
  t: 'debug-result';
  req: string;
  result: DebugAnswer;
}

const asked = singleton('cluster-debug-requests', () => new Map<string, (result: DebugAnswer) => void>());

/** How long a main waits for the one holding the session (a main that died holds nothing any more). */
export const DEBUG_REQUEST_TIMEOUT_MS = 3_000;

/** Ask the other processes to apply a debugger command; undefined when none holds the session (or queue mode is off). */
export function debugElsewhere(executionId: string, request: DebugRequest, timeoutMs = DEBUG_REQUEST_TIMEOUT_MS): Promise<DebugAnswer | undefined> {
  const state = clusterState();
  const relay = state.relay;
  if (!clusterActive() || !relay) return Promise.resolve(undefined);
  const req = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      asked.delete(req);
      resolve(undefined);
    }, timeoutMs);
    timer.unref?.();
    asked.set(req, (result) => {
      clearTimeout(timer);
      asked.delete(req);
      resolve(result);
    });
    const message: DebugControl = { t: 'debug', id: executionId, req, from: state.config.instanceId, ...(request.command && { command: request.command }), ...(request.breakpoints && { breakpoints: request.breakpoints }) };
    void relay.broadcast('control', message);
  });
}

/** The answer to a request of this process arrived (its inbox). */
export function settleDebugRequest(message: DebugResultMessage) {
  asked.get(message.req)?.(message.result);
}

/** Another process asks: answer only when this process holds the session (`apply` is the runner's debugExecution). */
export function answerDebugRequest(message: DebugControl, apply: (id: string, request: DebugRequest) => DebugAnswer) {
  const result = apply(message.id, { ...(message.command && { command: message.command }), ...(message.breakpoints && { breakpoints: message.breakpoints }) });
  // 404: not running here; whoever holds it answers.
  if (!result.ok && result.status === 404) return;
  void clusterState().relay?.send<DebugResultMessage>(message.from, { t: 'debug-result', req: message.req, result });
}

/**
 * A debugger command for a run that may be held by another main: tried here first (`local`, the runner's
 * debugExecution), then asked of the others in queue mode.
 */
export async function debugAnywhere(executionId: string, request: DebugRequest, local: (id: string, request: DebugRequest) => DebugAnswer): Promise<DebugAnswer> {
  const here = local(executionId, request);
  if (here.ok || here.status !== 404 || !clusterActive()) return here;
  return (await debugElsewhere(executionId, request)) ?? here;
}

// ---------------------------------------------------------------------------
// Where sessions held by other mains are paused
// ---------------------------------------------------------------------------

const remotePaused = singleton('cluster-remote-paused', () => new Map<string, PausedState>());

/** Where a run held by another process is paused (from its relayed events), if it is. */
export function pausedElsewhere(executionId: string): PausedState | undefined {
  return remotePaused.get(executionId);
}

/** Follow the relayed debugger events (exported for tests). */
export function notePausedEvent(event: ExecutionEvent) {
  if (event.type === 'execution.paused') remotePaused.set(event.executionId, { nodeId: event.nodeId, nodeName: event.nodeName, reason: event.reason, since: event.at });
  else if (event.type === 'execution.resumed' || event.type === 'execution.finished') remotePaused.delete(event.executionId);
}

singleton('cluster-remote-paused-watch', () =>
  bus.subscribe((message) => {
    if (message.channel === 'execution' && isRelayed(message)) notePausedEvent(message.event);
  }),
);
