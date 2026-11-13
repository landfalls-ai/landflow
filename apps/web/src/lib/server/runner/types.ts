/**
 * Shared types of the runner: what a run is started with, the reply a waiting HTTP request gets, a stretch of an
 * execution, and the errors the run, resume and re-run entry points throw.
 * (Split out of the former runner.ts; lib/server/runner.ts re-exports the public names.)
 */
import { nanoid } from 'nanoid';
import type { ExecutionMode, NodeItem } from '@landflow/protocol';
import type { ExecuteWorkflowOptions, ExecutionEvent, Workflow } from '@landflow/engine';
import type { EvaluationRef } from '../../shared/evaluations';
import type { ExecutionMcpInfo, ExecutionRecord, FormCompletion, RerunOf } from '../../shared/types';
import { HttpError } from '../errors';
import type { DebugSession } from './state';

/** How deep Execute Workflow may nest executions. */
export const MAX_WORKFLOW_DEPTH = 10;

/** The Error Trigger's node type (error workflows start there). */
export const ERROR_TRIGGER = 'core.errorTrigger';

/**
 * What the HTTP request behind a run is waiting for, delivered while the run continues:
 * Respond to Webhook's response, or the end screen of a Form node.
 */
export type RunReply =
  | {
      type: 'webhook';
      status: number;
      headers: Record<string, string>;
      body?: string;
      json?: unknown;
      redirect?: string;
      /** A stored file, opened by Respond to Webhook (it is streamed as the body). */
      file?: { stream: ReadableStream<Uint8Array>; mimeType: string; fileName?: string; fileSize: number };
    }
  | { type: 'form'; completion: FormCompletion };

export interface RunOptions {
  workflow: Workflow;
  mode: ExecutionMode;
  startNodeId?: string;
  triggerItems?: NodeItem[];
  /** A poll trigger's new items: that node outputs them without running again. */
  triggerOutput?: { nodeId: string; items: NodeItem[] };
  /** Stop after this node. */
  destinationNodeId?: string;
  /** Re-run part of an earlier execution, reusing its data. */
  partial?: { executionId: string; nodeId: string; scope: 'from' | 'only' };
  debug?: { breakpoints?: string[]; step?: boolean };
  rerunOf?: RerunOf;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void;
  /** Called once the execution has an id, before the first node runs. */
  onStart?: (executionId: string) => void;
  /** Receives Respond to Webhook's reply or a Form node's end screen (the first webhook reply only). */
  onReply?: (reply: RunReply) => void;
  /** Started by an Execute Workflow node of another execution. */
  parent?: { executionId: string; nodeId?: string };
  /** An error workflow run, for this failed execution (it never starts another error workflow). */
  errorOf?: string;
  /** Use this id (from newExecutionId()): webhook and form uploads are stored under it before the run starts. */
  executionId?: string;
  /** A trigger call's Idempotency-Key: the same key within the retention window rejects with DuplicateRunError (its execution id). */
  idempotencyKey?: string;
  /** Not held back by the workflow's concurrency limit (manual retries). */
  bypassConcurrency?: boolean;
  /** A retry of this failed execution (attempt 1 = the first retry). */
  retry?: { of: string; attempt: number };
  /** Continue from this failed execution's last checkpoint: what ran before it is reused, the failed node runs again. */
  fromCheckpoint?: { executionId: string };
  /** A test case of an offline evaluation run (lib/server/evaluations); sub-executions inherit it. */
  evaluation?: EvaluationRef;
  /** Give nodes ctx.sendChunk: what they stream (an AI Agent's reply) arrives as node.chunk events in onEvent (chat and streaming webhook runs). */
  streaming?: boolean;
  /** The run of events a trigger's debounce or batching held (lib/server/trigger-buffers.ts): it is not held again. */
  buffered?: { kind: 'debounce' | 'batch'; key: string; count: number };
  /** An MCP tool call on a plugin's endpoint (lib/server/mcp/plugin-servers.ts): the caller and the tool, kept on the record. */
  mcp?: ExecutionMcpInfo;
}

/** A fresh execution id. */
export const newExecutionId = () => `ex_${nanoid(12)}`;

export interface Segment {
  record: ExecutionRecord;
  workflow: Workflow;
  /** Start or resume options for the engine. */
  engine: Partial<ExecuteWorkflowOptions>;
  debug?: DebugSession;
  signal?: AbortSignal;
  onEvent?: (event: ExecutionEvent) => void;
  onStart?: (executionId: string) => void;
  onReply?: (reply: RunReply) => void;
  streaming?: boolean;
  /** Queue mode: a worker runs this stretch of a job here (it is never handed on). */
  dispatched?: boolean;
}

export class ResumeError extends HttpError {
  constructor(message: string, status = 409) {
    super(message, status);
  }
}

export class RerunError extends HttpError {
  constructor(message: string, status = 400) {
    super(message, status);
  }
}
