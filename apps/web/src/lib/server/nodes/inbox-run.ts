/**
 * What the nodes that wait in the approval inbox share (wave ap1, C13): the graph a run uses, why a run that is no editor's
 * cannot wait, and the opening of an AI Judge's request. Moved out of `nodes/agents.ts` unchanged (Run an Agent imports them).
 */
import type { IExecuteContext } from '@landflow/sdk';
import type { InboxOpen, RefuseWhy } from '../../shared/approval-inbox';
import { EVIDENCE_OUTPUT_CHARS, type JudgeEvidence } from '../../shared/judge';
import type { TraceContent } from '../../shared/run-trace';
import type { ExecutionRecord } from '../../shared/types';
import { JOURNAL_SUMMARY_CHARS } from '../../shared/run-trace';
import { contentOf, cutStrings } from '../journal/content';
import type { InboxPort } from '../approval-inbox/port';

/** AP02: the graph this run uses: its own record's, else the saved version it started with, else the saved workflow. */
export async function runGraph(executionId: string, workflowId: string | undefined) {
  const { liveExecution } = await import('../runner');
  const { store } = await import('../store');
  const record = liveExecution(executionId) ?? (await store.loadExecution(executionId));
  const id = workflowId ?? record?.workflowId;
  const versionId = record?.versionId ?? (await import('../agents/versions')).runVersions(executionId, record)?.workflow.versionId;
  const snapshot = record?.workflow ?? (versionId && id ? (await import('../versions')).getVersion(id, versionId)?.workflow : undefined) ?? (id ? store.getWorkflow(id) : undefined);
  return { record, workflow: snapshot, workflowId: id };
}

/**
 * Wave ap1: why a run that is no editor's cannot wait for an approval, whatever its execution mode: the hosted chat page
 * (`core.chatTrigger`, started in mode 'webhook') cannot show one and an MCP call answers its caller at once. Read from the run's
 * own record only: a workflow such a run called was stamped with that trigger when it started (runner/run.ts), so no parent has to
 * be found later. A run with no `triggerType` (one that waits across the upgrade) is judged by the first node it ran, and a stamped type is checked the same way: unless that
 * is a known trigger that can wait, it refuses (fail closed); undefined for every trigger that can wait.
 */
export async function triggerRefusal(executionId: string): Promise<RefuseWhy | undefined> {
  const { liveExecution } = await import('../runner');
  const { store } = await import('../store');
  const record: ExecutionRecord | undefined = liveExecution(executionId) ?? (await store.loadExecution(executionId));
  if (!record) return 'unknownOrigin';
  if (record.mode === 'mcp') return 'mcp';
  const { recordTrigger, triggerCanWait } = await import('../runner/trigger');
  const { MAX_WORKFLOW_DEPTH } = await import('../runner/types');
  // A record from before the wave has no stamp: its parent's verdict, else its first node. Read from the live run first, then the saved one.
  // The ancestors are read first (async, live then saved), so the sync verdict never reads the store's cache.
  const known = new Map<string, ExecutionRecord>([[record.executionId, record]]);
  for (let at = record, hops = 0; !record.triggerType && at.parentExecutionId && !known.has(at.parentExecutionId) && hops <= MAX_WORKFLOW_DEPTH; hops++) {
    const parent = liveExecution(at.parentExecutionId) ?? (await store.loadExecution(at.parentExecutionId));
    if (!parent) break;
    known.set(parent.executionId, parent);
    at = parent;
  }
  const type = recordTrigger(record, (id) => known.get(id));
  // Fail closed on whatever type it ends with, stamped or derived: only a known trigger that can wait (or the manual one) waits.
  if (type !== 'core.mcpTrigger' && type !== 'core.chatTrigger' && !triggerCanWait(type)) return 'unknownOrigin';
  if (type === 'core.mcpTrigger') return 'mcp';
  if (type === 'core.chatTrigger') return 'hostedChat';
  return undefined;
}

/**
 * What the item shows in the inbox, by the run's trace content mode (`full` the whole item, `summaries` each text cut, `off`
 * nothing: the row never keeps more of the item than the Run Trace does). Always an object: the row's params are one.
 */
export function judgeParams(mode: TraceContent, subject: unknown): Record<string, unknown> {
  if (mode === 'off') return {};
  const shown = mode === 'summaries' ? cutStrings(subject, JOURNAL_SUMMARY_CHARS) : subject;
  return shown && typeof shown === 'object' && !Array.isArray(shown) ? (shown as Record<string, unknown>) : { input: shown };
}

/** The judge's evidence by the same rule: `off` keeps names, counts and the reason code only (the model's words may quote the item). */
export function judgeEvidenceFor(mode: TraceContent, evidence: JudgeEvidence): JudgeEvidence {
  if (mode === 'off') return { fallbackReason: evidence.fallbackReason, rounds: evidence.rounds, toolCalls: evidence.toolCalls, ...(evidence.confidence !== undefined && { confidence: evidence.confidence }), steps: evidence.steps.map((step) => ({ tool: step.tool, input: {}, output: '', ...(step.isError && { isError: true }) })) };
  const kept = mode === 'summaries' ? (cutStrings(evidence, JOURNAL_SUMMARY_CHARS) as JudgeEvidence) : evidence;
  return { ...kept, steps: kept.steps.map((step) => ({ ...step, output: String(step.output).slice(0, EVIDENCE_OUTPUT_CHARS) })) };
}

/** C13: one request in the approval inbox for an AI Judge that could not decide (idempotent: the id is `judge:<item>`). */
export async function openJudgeRequest(ctx: IExecuteContext, port: InboxPort, run: { itemIndex: number; subject: unknown; evidence: JudgeEvidence }) {
  const { runVersions } = await import('../agents/versions');
  const { unattendedTrigger } = await import('../agents/unattended');
  const { homeProjectId } = await import('../projects/store');
  const executionId = ctx.getExecutionId();
  const { record, workflow, workflowId: graphId } = await runGraph(executionId, ctx.getWorkflowId());
  const workflowId = graphId ?? 'unknown';
  const node = ctx.getNode();
  const mode = contentOf(workflow?.settings?.traceContent);
  const trigger = workflow?.nodes.filter((n) => !n.disabled).flatMap((n) => unattendedTrigger(n.type) ?? [])[0] ?? 'trigger';
  const number = (() => {
    try {
      return runVersions(executionId, record)?.workflow.number;
    } catch {
      return undefined;
    }
  })();
  const projectId = homeProjectId('workflow', workflowId);
  const call: InboxOpen = {
    executionId,
    callId: judgeCallId(run.itemIndex),
    workflowId,
    workflowName: workflow?.name ?? workflowId,
    ...(number !== undefined && { workflowVersion: number }),
    nodeId: node.id,
    nodeName: node.name ?? node.id,
    // A judge has no agent or session: the row's NOT NULL columns hold '' (migration 2907), the title says whose it is.
    agentId: '',
    agentName: 'AI Judge',
    sessionId: '',
    tool: node.name ?? node.id,
    params: judgeParams(mode, run.subject),
    trigger,
    ...(projectId && { projectId }),
    kind: 'judge',
    evidence: judgeEvidenceFor(mode, run.evidence),
  };
  return port.open([call]);
}

/** The id of the one request an item's judgement opens (also the approval wait's call id). */
export const judgeCallId = (itemIndex: number): string => `judge:${itemIndex}`;
