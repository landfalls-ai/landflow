/**
 * What Spotlight (and the instance MCP server) reads of one run to fix it (wave ag4, AG20): every node's status and
 * error (an HTTP node's status code and the response body's first 400 characters), up to three input and output items
 * clipped, the plugin's log lines for the call, and, for a Run an Agent / Run a Team node, the agent's tool calls in
 * order with the reply's first 400 characters. The same data the logs panel, the Run Trace and `explain_failure` show;
 * no new store. Never a secret: everything goes through the debug tools' redactor (credential values of the workflow's
 * nodes, `$vars`, secret-named keys).
 */
import type { NodeRun } from '@landflow/engine';
import type { NodeItem } from '@landflow/protocol';
import { clip } from '@/lib/shared/assistant-ops';
import type { RunLog, RunLogNode } from '@/lib/shared/tenant-catalog';
import type { ExecutionRecord } from '@/lib/shared/types';
import { agentStore } from '../agents/store';
import { redactorFor } from '../mcp/debug-tools';
import { liveExecution, liveExecutions } from '../runner';
import { store } from '../store';
import { canResource, type Actor } from '../projects/access';

const ITEMS = 3;
const LOG_LINES = 20;
const TEXT = 400;
const AGENT_TYPES = new Set(['core.messageAgent', 'core.runTeam']);

const cut = (text: string, max = TEXT) => (text.length > max ? `${text.slice(0, max)}…` : text);

const statusOf = (s: ExecutionRecord['status']): RunLog['status'] => (s === 'queued' ? 'running' : s);

/** The HTTP status an error carries: the HTTP node's "HTTP 400" message. */
const httpCodeOf = (message: string): number | undefined => {
  const code = /^HTTP (\d{3})\b/.exec(message)?.[1];
  return code ? Number(code) : undefined;
};

const itemsOf = (batches: NodeItem[][] | undefined): unknown[] | undefined => {
  const items = batches?.flat().slice(0, ITEMS).map((i) => clip(i.json));
  return items?.length ? items : undefined;
};

/** The agent session a Run an Agent node ran: the id its output names, else the session linked to this execution and node. */
function sessionFor(record: ExecutionRecord, nodeId: string, agentId: string | undefined, run: NodeRun | undefined) {
  const named = run?.outputs.flat().map((i) => i.json?.sessionId).find((v) => typeof v === 'string');
  if (typeof named === 'string') return agentStore.getSession(named);
  if (!agentId) return undefined;
  for (const s of agentStore.listSessions(agentId, 30)) {
    const session = agentStore.getSession(s.id);
    if (session?.execution?.executionId === record.executionId && session.execution.nodeId === nodeId) return session;
  }
  return undefined;
}

const isEmpty = (value: unknown): boolean => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length) || (typeof value === 'object' && !Array.isArray(value) && !Object.keys(value as object).length);

function agentPart(record: ExecutionRecord, nodeId: string, parameters: Record<string, unknown>, run: NodeRun | undefined): Pick<RunLogNode, 'agentCalls' | 'agent'> {
  const agentId = typeof parameters.agentId === 'string' ? parameters.agentId : typeof run?.outputs[0]?.[0]?.json?.agentId === 'string' ? (run.outputs[0][0].json.agentId as string) : undefined;
  const session = sessionFor(record, nodeId, agentId, run);
  const agent = (agentId && agentStore.get(agentId)) || undefined;
  const reply = run?.outputs[0]?.[0]?.json?.reply;
  const since = run?.startedAt ? Date.parse(run.startedAt) : NaN; // a reused session ("Continue by key") holds earlier runs' calls
  const calls = (session?.timeline ?? []).filter((e) => Number.isNaN(since) || !(Date.parse(e.at) < since)).flatMap((e) =>
    e.type === 'tool' && e.status !== 'running'
      ? [
          {
            tool: e.tool,
            status: (e.status === 'awaiting_approval' ? 'denied' : e.status === 'success' && isEmpty(e.output) ? 'empty' : e.status) as 'success' | 'error' | 'denied' | 'empty',
            ...(e.error && { error: cut(e.error) }),
            input: clip(e.input),
            ...(e.output !== undefined && { output: clip(e.output) }),
          },
        ]
      : [],
  );
  return {
    ...(calls.length && { agentCalls: calls }),
    ...((agentId || agent) && { agent: { id: agentId ?? agent!.id, name: agent?.name ?? '', ...(typeof reply === 'string' && reply && { reply: cut(reply) }) } }),
  };
}

/**
 * The log of one execution of a workflow, for `actor` (undefined: the instance, no check). Without `executionId`, the
 * latest of the workflow. Undefined when there is none, or the actor may not read the workflow ("not found").
 */
export async function runLog(actor: Actor | undefined, input: { workflowId?: string; executionId?: string }): Promise<RunLog | undefined> {
  let record: ExecutionRecord | undefined;
  if (input.executionId) record = liveExecution(input.executionId) ?? (await store.loadExecution(input.executionId));
  else if (input.workflowId) {
    const live = liveExecutions(input.workflowId)[0];
    const latest = live?.id ?? store.listExecutions({ workflowId: input.workflowId, limit: 1 })[0]?.id;
    record = latest ? (liveExecution(latest) ?? (await store.loadExecution(latest))) : undefined;
  }
  if (!record) return undefined;
  if (input.workflowId && record.workflowId !== input.workflowId) return undefined;
  if (actor && !canResource(actor, 'workflow', record.workflowId, 'read')) return undefined;
  const workflow = record.workflow ?? store.getWorkflow(record.workflowId);
  const redact = redactorFor(workflow);
  const order = [...new Set(record.executionOrder ?? [])];
  const nodes: RunLogNode[] = [];
  for (const id of order) {
    const runs = record.runData[id] ?? [];
    const run = [...runs].reverse().find((r) => r.status === 'error') ?? runs.at(-1);
    if (!run) continue;
    const node = workflow?.nodes.find((n) => n.id === id);
    const name = node?.name ?? record.nodeNames?.[id] ?? id;
    const message = run.error?.message;
    const httpCode = message ? httpCodeOf(message) : undefined;
    const logs = (run.logs ?? []).slice(-LOG_LINES).map((l) => cut(`${l.level}: ${l.message}`, 300));
    nodes.push({
      name,
      type: node?.type ?? '',
      status: run.status,
      durationMs: run.durationMs,
      ...(run.error && {
        error: { message: cut(run.error.message), ...(run.error.description && { description: cut(run.error.description) }), ...(httpCode && { httpCode }) },
      }),
      ...(itemsOf(run.inputs) && { input: itemsOf(run.inputs) }),
      ...(itemsOf(run.outputs) && { output: itemsOf(run.outputs) }),
      ...(logs.length && { logs }),
      ...(node && AGENT_TYPES.has(node.type) && agentPart(record, id, node.parameters as Record<string, unknown>, run)),
    });
  }
  const failed = nodes.find((n) => n.status === 'error')?.name ?? (record.status === 'error' ? record.error?.nodeName : undefined);
  return redact({
    executionId: record.executionId,
    status: statusOf(record.status),
    startedAt: record.startedAt,
    ...(failed && { failed }),
    nodes,
  });
}
