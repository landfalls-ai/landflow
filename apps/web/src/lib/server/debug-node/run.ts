/**
 * The one-node local override (docs/specs/19-debug-token.md, "One-node local override"): run ONE node of a recorded
 * execution against a plugin build the developer serves, and give back what it did, tagged as a debug run.
 *
 * What makes it safe to build:
 * - The credential is a `runs:debug` token (auth/debug-tokens.ts): never minted with a read scope, bound to one execution
 *   and one node, single use (spent by inserting its id in `debug_node_runs`, whose primary key makes the claim atomic),
 *   gone when revoked or expired or when its minter loses the right to run the workflow.
 * - Everything is off while the owner's setting is off (./settings.ts), and the host calls only a URL whose host is on the
 *   owner's allowed list. It never reaches out unprompted: the developer opens the tunnel and names the URL.
 * - The node's input is the input of its RECORDED run in that execution: the caller cannot send input of its own.
 * - The plugin gets the resolved parameters and that input, and never a credential. `$vars` read as "[redacted]" and
 *   `$secrets` are not available, as in `explain_failure`.
 * - The result goes back to the caller only. It is not written to the execution (its outputs, steps and journal are
 *   untouched) and no execution is created. The use is in `debug_node_runs` (metadata) and the audit log
 *   (`debug.node.run`), written BEFORE the plugin is called.
 */
import { PROTOCOL_VERSION, HTTP_PATHS, type ExecuteRequest, type ExecuteResponse, type JsonObject, type NodeItem } from '@landflow/protocol';
import { ExpressionResolver, type Workflow } from '@landflow/engine';
import { recordAudit } from '../audit';
import { authDb } from '../auth/db';
import { DEBUG_RUN_SCOPE, recordDebugUse, verifyDebugToken, type DebugTokenRecord } from '../auth/debug-tokens';
import { redactorFor } from '../mcp/debug-tools';
import { liveExecution } from '../runner';
import { store } from '../store';
import { variables } from '../variables';
import { checkPluginUrl, getDebugNodeSettings } from './settings';

const TIMEOUT_MS = Number(process.env.LANDFLOW_DEBUG_NODE_TIMEOUT_MS ?? 30_000);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_ITEMS_RETURNED = 50;

export interface DebugNodeRequest {
  executionId?: string;
  node?: string;
  pluginUrl?: string;
}

export interface DebugNodeAnswer {
  status: number;
  body: Record<string, unknown>;
}

const refuse = (status: number, error: string): DebugNodeAnswer => ({ status, body: { error } });

function audit(grant: DebugTokenRecord | undefined, outcome: 'success' | 'failure' | 'denied', summary: string, details: Record<string, unknown>): boolean {
  try {
    return Boolean(
      recordAudit({
        action: 'debug.node.run',
        outcome,
        target: { type: 'execution', id: grant?.executionId ?? String(details.executionId ?? '') },
        summary,
        details: { via: 'debug-token', ...(grant && { debugId: grant.id, mintedBy: grant.createdBy, executionId: grant.executionId, workflowId: grant.workflowId, node: grant.nodeName }), ...details },
        // The token is nobody: the minter is named in the details, never as the actor.
        actor: 'anonymous',
      }),
    );
  } catch {
    return false;
  }
}

/** POST the request to the developer's plugin: no redirects (they could leave the allowed list), a time limit and a size limit. */
async function callPlugin(url: URL, request: ExecuteRequest): Promise<ExecuteResponse> {
  const response = await fetch(new URL(HTTP_PATHS.execute, url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-landflow-debug-run': 'true' },
    body: JSON.stringify(request),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('The plugin answered with more than 8 MiB');
  if (!response.ok) {
    let message = text.slice(0, 500);
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? message;
    } catch {}
    throw new Error(`The plugin answered ${response.status}: ${message}`);
  }
  return JSON.parse(text) as ExecuteResponse;
}

export async function runDebugNode(token: string | undefined, input: DebugNodeRequest): Promise<DebugNodeAnswer> {
  const checked = verifyDebugToken(token);
  if (!checked.ok) {
    if (checked.record) audit(checked.record, 'denied', `Debug run refused (${checked.reason}) for execution ${checked.record.executionId}`, { reason: checked.reason });
    return refuse(401, checked.reason === 'exhausted' ? 'This debug token has been used: a runs:debug token works once' : { invalid: 'Invalid debug token', expired: 'This debug token has expired', revoked: 'This debug token was revoked', exhausted: '', user: 'This debug token is no longer allowed' }[checked.reason]);
  }
  const grant = checked.record;
  const denied = (status: number, reason: string, message: string, extra: Record<string, unknown> = {}) => {
    audit(grant, 'denied', `Debug run refused (${reason}) for execution ${grant.executionId}`, { reason, ...extra });
    return refuse(status, message);
  };
  if (!grant.scopes.includes(DEBUG_RUN_SCOPE) || !grant.nodeId) return denied(403, 'scope', `This debug token lacks the “${DEBUG_RUN_SCOPE}” scope`);
  if (!getDebugNodeSettings().enabled) return denied(403, 'disabled', 'Local node overrides are off on this host');
  if (!input.executionId || input.executionId !== grant.executionId) return denied(404, 'other execution', `Execution ${input.executionId ?? '?'} not found`, { asked: input.executionId });
  if (!input.node || (input.node !== grant.nodeId && input.node !== grant.nodeName)) return denied(403, 'other node', `This debug token is bound to the node “${grant.nodeName}”`, { asked: input.node });
  const url = checkPluginUrl(input.pluginUrl ?? '');
  if (!url.ok) return denied(403, 'plugin url', url.reason, { pluginUrl: String(input.pluginUrl).slice(0, 200) });

  const record = liveExecution(grant.executionId) ?? store.getExecution(grant.executionId);
  if (!record || record.workflowId !== grant.workflowId) return denied(404, 'execution gone', `Execution ${grant.executionId} not found`);
  const workflow: Workflow | undefined = record.workflow ?? store.getWorkflow(record.workflowId);
  const node = workflow?.nodes.find((n) => n.id === grant.nodeId);
  const run = record.runData[grant.nodeId]?.at(-1);
  if (!workflow || !node || !run) return denied(409, 'never ran', `The recorded execution never ran “${grant.nodeName}”, so there is no input to replay`);

  // The use: audited first ("no event, no data"), then spent. The primary key makes the claim atomic.
  if (!audit(grant, 'success', `Debug run of “${grant.nodeName}” in execution ${grant.executionId} against ${url.url.host}`, { pluginHost: url.url.host, nodeType: node.type })) {
    return refuse(500, 'The use of this debug token could not be audited, so it was refused');
  }
  const now = new Date().toISOString();
  const claimed = authDb().insertNew('debug_node_runs', { token_id: grant.id, execution_id: grant.executionId, workflow_id: grant.workflowId, node_id: grant.nodeId, plugin_host: url.url.host, started_at: now, finished_at: null, status: 'running' });
  if (!claimed) return denied(401, 'exhausted', 'This debug token has been used: a runs:debug token works once');
  recordDebugUse(grant.id);
  const finish = (status: string) => authDb().upsert('debug_node_runs', { token_id: grant.id, execution_id: grant.executionId, workflow_id: grant.workflowId, node_id: grant.nodeId, plugin_host: url.url.host, started_at: now, finished_at: new Date().toISOString(), status });

  const inputs: NodeItem[][] = run.inputs.length ? run.inputs : [[]];
  const masked = Object.fromEntries(Object.keys(variables.forWorkflow(workflow.id)).map((key) => [key, '[redacted]']));
  const nodeOutputs = Object.fromEntries(workflow.nodes.map((n) => [n.name, record.runData[n.id]?.at(-1)?.outputs[0] ?? []]));
  const resolver = new ExpressionResolver({ items: inputs[0] ?? [], nodeOutputs, workflow: { id: workflow.id, name: workflow.name }, execution: { id: record.executionId, mode: record.mode }, parameters: node.parameters, variables: masked });
  const redact = redactorFor(workflow);
  const tagged = { debugRun: true as const, notRecorded: 'This result is not stored in the execution: its outputs, steps and trace are unchanged.' };
  let response: ExecuteResponse;
  try {
    const request: ExecuteRequest = {
      protocol: PROTOCOL_VERSION,
      executionId: `debug_${record.executionId}`,
      workflowId: workflow.id,
      mode: 'manual',
      node: { id: node.id, name: node.name, type: node.type, typeVersion: node.typeVersion },
      parameters: resolver.resolveParameters(node.parameters, 0) as JsonObject,
      itemParameters: (inputs[0] ?? []).map((_item, index) => resolver.resolveParameters(node.parameters, index) as JsonObject),
      inputs,
      // No credentials, ever: the local plugin sees the node's resolved input only.
      ...(node.onError === 'continue' && { continueOnFail: true }),
    };
    response = await callPlugin(url.url, request);
  } catch (error) {
    const message = (error as Error).message;
    audit(grant, 'failure', `Debug run of “${grant.nodeName}” failed: ${message.slice(0, 200)}`, { pluginHost: url.url.host });
    finish('error');
    return { status: 502, body: redact({ ...tagged, executionId: grant.executionId, node: grant.nodeName, status: 'error', error: { message } }) as Record<string, unknown> };
  }
  const failed = Boolean(response.error);
  finish(failed ? 'error' : 'success');
  const items = (response.outputs ?? []).map((branch) => branch.length);
  return {
    status: 200,
    body: redact({
      ...tagged,
      executionId: grant.executionId,
      node: grant.nodeName,
      nodeType: node.type,
      status: failed ? 'error' : 'success',
      pluginHost: url.url.host,
      ...(response.error && { error: response.error }),
      inputItems: inputs[0]?.length ?? 0,
      outputItems: items,
      output: (response.outputs?.[0] ?? []).slice(0, MAX_ITEMS_RETURNED).map((item) => item.json),
      ...(response.logs?.length && { nodeLogs: response.logs.slice(-20) }),
      recorded: { status: run.status, outputItems: (run.outputs ?? []).map((branch) => branch.length) },
    }) as Record<string, unknown>,
  };
}
