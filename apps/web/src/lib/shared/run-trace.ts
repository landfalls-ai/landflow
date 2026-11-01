/**
 * Run Trace: the journal of one execution (docs/run-trace.md). Any flow, agentic or not, is told in five generic things:
 * actors (who), spans (interactions: steps, requests to other agents, waits for people, tool and model calls), artifacts
 * (what was made), checks (what was verified) and the outcome. Span kinds follow OTel GenAI (invoke_workflow,
 * invoke_agent, execute_tool, chat), A2A (a request another agent works on, input-required) and OpenInference
 * (AGENT, TOOL, LLM, GUARDRAIL, EVALUATOR); the words a domain uses (pull request, ticket) come from the flow's profile.
 *
 * The host writes the journal (lib/server/journal); `GET /api/executions/:id/events` reads it and the live stream sends
 * new events as `journal` bus events. `lib/shared/run-trace-model.ts` folds it into what the screens show.
 */
import type { NodeArtifact, NodeCheck } from '@landflow/protocol';

export type ActorType = 'agent' | 'human' | 'system' | 'model' | 'tool';

/** Someone or something that takes part in a run. */
export interface RunActor {
  /**
   * Stable within the run: `workflow` (the flow itself), `node:<nodeId>` (an agent or step node), `remote:<name>` (an A2A
   * agent), `agent:<agentId>` (a Landflow agent), `model:<model>`, `human:<user id or channel user>`.
   */
  id: string;
  name: string;
  type: ActorType;
  /** What it does in this flow ("Planner", "Billing agent"): the node's notes or the agent's role, when known. */
  role?: string;
  /** The node type, for its icon. */
  nodeType?: string;
}

/**
 * What a span is.
 * - `run`: the execution (invoke_workflow).
 * - `step`: a node of the flow that is not an agent (CHAIN).
 * - `agent`: an agent at work: an agent node, a Landflow agent's turn (invoke_agent).
 * - `delegate`: a request to another agent the caller waits on (an A2A task, a sub-agent).
 * - `handoff`: the conversation passes to another agent, which answers from then on.
 * - `wait`: waiting for a person (an approval, a form, an agent's question).
 * - `tool`: a tool call (execute_tool), also a remote agent's own tool calls.
 * - `model`: one model call (chat).
 */
export type SpanKind = 'run' | 'step' | 'agent' | 'delegate' | 'handoff' | 'wait' | 'tool' | 'model';

export type SpanStatus = 'running' | 'waiting' | 'success' | 'error' | 'canceled';

export interface TokenCounts {
  inputTokens: number;
  outputTokens: number;
}

export type RunArtifact = NodeArtifact;

/** A check: one a node reported (ctx.check), a built-in one (phase 3) or a person's decision on a failed one. */
export interface RunCheck extends NodeCheck {
  /** Who checked: a node (ctx.check), a built-in check of the Run report, a person. */
  source?: 'node' | 'builtin' | 'person';
  /** A person settled a failed check: accepted as is, or sent back for a fix. */
  resolution?: { decision: 'accepted' | 'sent_back'; by: string; note?: string };
}

/** Fields every journal event has. */
export interface JournalBase {
  /** 1, 2, 3… within the execution: `?after=<seq>` reads what came later. */
  seq: number;
  executionId: string;
  at: string;
  /**
   * For `span.*` the span itself, else the span it happened in. Deterministic: `run`, `node:<nodeId>:<n>` (the node's
   * n-th run, from 0), `<span>/step:<stepId>` (a remote agent's tool call), `<span>/wait`, `<span>/turn:<n>`.
   */
  spanId: string;
  /** The run's OTel trace (when telemetry recorded one): other systems' spans join on it. */
  traceId?: string;
}

export type JournalEvent = JournalBase &
  (
    | {
        type: 'span.started';
        parentSpanId?: string;
        kind: SpanKind;
        /** "Planner", "Bash: pnpm test", "qwen3-coder", "Approve the refund". */
        name: string;
        /** Who does the work. */
        actor: RunActor;
        /** Who asked for it (a delegate's or tool's calling agent, the person who started the run). */
        caller?: RunActor;
        nodeId?: string;
        /** What was asked: the request's text, the tool's arguments (redacted, cut to 32 KB). */
        input?: unknown;
        /**
         * The OTel span of the step, when recorded; A2A task and context ids; anything else worth keeping. A delegate's
         * `reason` is why the caller asked ("why you are asking and what done looks like"); a flow node that ran again
         * after a wait has `resumed`.
         */
        attrs?: Record<string, unknown>;
      }
    | {
        type: 'span.updated';
        status?: SpanStatus;
        /** A remote agent's task state (`working`, `input-required`), as A2A names it. */
        state?: string;
        /** What it is doing now, one line. */
        note?: string;
        attrs?: Record<string, unknown>;
      }
    | {
        type: 'span.ended';
        status: Exclude<SpanStatus, 'running'>;
        /** What came back: the reply, the tool's result (redacted, cut to 32 KB). */
        output?: unknown;
        error?: string;
        usage?: TokenCounts;
        attrs?: Record<string, unknown>;
      }
    /**
     * Something said that is not a span's input or output: a chat message that started the run, a person's decision.
     * `inline`: words a member said between its tool calls (a remote agent's text, in order with its steps): they belong to
     * that request, shown with the member's turn rather than in the story.
     */
    | { type: 'message'; from: RunActor; to?: RunActor; text: string; inline?: boolean }
    | { type: 'artifact'; artifact: RunArtifact }
    | { type: 'check'; check: RunCheck }
  );

export type JournalEventType = JournalEvent['type'];

/** What a journal event is before the writer numbers it. */
export type JournalDraft = JournalEvent extends infer E ? (E extends JournalEvent ? Omit<E, 'seq' | 'executionId' | 'at'> & { at?: string } : never) : never;

/** How much content the journal keeps (the workflow setting `traceContent`, else LANDFLOW_TRACE_CONTENT). */
export type TraceContent = 'full' | 'summaries' | 'off';

/** Largest serialized event; longer content is cut (with `…[cut]`). */
export const JOURNAL_EVENT_MAX_BYTES = 32 * 1024;
/** Text kept per field with `traceContent: 'summaries'`. */
export const JOURNAL_SUMMARY_CHARS = 400;
/** Days the journal is kept (LANDFLOW_TRACE_RETENTION_DAYS). */
export const JOURNAL_RETENTION_DAYS = 30;

/** A tool step's input as an object: remote agents' steps (A2A, kagent's Claude Code) carry their arguments as JSON text. */
export function toolInput(input: unknown): unknown {
  if (typeof input !== 'string' || !/^\s*[{[]/.test(input)) return input;
  try {
    return JSON.parse(input);
  } catch {
    return input;
  }
}
