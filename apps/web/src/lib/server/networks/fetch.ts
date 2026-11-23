/**
 * The seam between the HTTP Request node and the runners (C29): `networkFetch(networkId, meta, timeoutMs)` is a `fetch` that
 * sends the prepared request to an online runner of the network and builds a `Response` from the runner's answer, so
 * the node reads it exactly as it reads one fetched in the host. The host never fetches for a network call.
 *
 * Two fences. Here: a project's network is for that project's workflows only (D13: checked from the execution's workflow
 * at run time, and `runIn` is not an expression, so data can't pick a network). On the runner: its own allow-list.
 * The request body is buffered (10 MiB at most; multipart and file bodies too) and the credential header travels inside
 * the sealed call row to the runner and nowhere else; the audit event names the runner, node and workflow, never a URL.
 */
import { NodeOperationError } from '@landflow/sdk';
import { recordAudit } from '../audit';
import { singleton } from '../singleton';
import { homeProjectId } from '../projects';
import { awaitAnswer, enqueueCall, type CallRequest } from './calls';
import { networkRow } from './store';

const MAX_BODY_BYTES = 10 * 1024 * 1024;
/** Slack after the node's own timeout for the runner to report its own (it enforces the timeout too). */
const GRACE_MS = 5_000;
/** Responses with no body by definition. */
const NO_BODY = new Set([101, 204, 205, 304]);

/** (run, node, network) triples already audited: the first call of each is the event (C29-D3). Bounded; a restart repeats at worst once. */
const audited = () => singleton('network-call-audited', () => new Set<string>());

export interface NetworkCallMeta {
  executionId: string;
  workflowId?: string;
  node: string;
}

/** The request's body as bytes, and the headers fetch would send (a multipart body brings its boundary). */
async function prepare(url: URL, init: RequestInit): Promise<{ headers: Array<[string, string]>; body?: Buffer }> {
  const method = (init.method ?? 'GET').toUpperCase();
  const asked = new Request(url, { method, headers: init.headers, ...(init.body != null && { body: init.body, duplex: 'half' }) } as RequestInit);
  const bytes = init.body == null ? undefined : Buffer.from(await asked.arrayBuffer());
  if (bytes && bytes.length > MAX_BODY_BYTES) throw new NodeOperationError('The request body is larger than 10 MiB', { description: 'A call through a network runner buffers its body: send a smaller one, or run the node in the host.' });
  const headers: Array<[string, string]> = [];
  asked.headers.forEach((value, name) => headers.push([name, value]));
  return { headers, ...(bytes?.length && { body: bytes }) };
}

export function networkFetch(networkId: string, meta: NetworkCallMeta, timeoutMs: number): (url: URL, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const network = networkRow(networkId);
    if (!network) throw new NodeOperationError('Network not found', { description: 'The node’s Run In names a network that was deleted. Pick another in the node, or Host.' });
    if (network.projectId && (!meta.workflowId || homeProjectId('workflow', meta.workflowId) !== network.projectId)) {
      throw new NodeOperationError('This network belongs to another project', { description: 'A network bound to a project is for that project’s workflows. Ask an admin for an instance-wide network, or pick another.' });
    }
    const { headers, body } = await prepare(url, init);
    const call: CallRequest = { method: (init.method ?? 'GET').toUpperCase(), url: url.toString(), headers, ...(body && { body: body.toString('base64') }), timeoutMs };
    const id = await enqueueCall(networkId, call, { executionId: meta.executionId, workflowId: meta.workflowId, node: meta.node });
    const answer = await awaitAnswer(id, { timeoutMs: timeoutMs + GRACE_MS, signal: init.signal ?? undefined });
    const key = `${meta.executionId}:${meta.node}:${networkId}`;
    if (!audited().has(key)) {
      if (audited().size > 5_000) audited().clear();
      audited().add(key);
      recordAudit({
        action: 'network.call',
        actor: 'system',
        target: { type: 'network', id: networkId, name: network.name },
        project: network.projectId ?? null,
        summary: `Sent an HTTP request through the network ${network.name}`,
        details: { executionId: meta.executionId, workflowId: meta.workflowId, node: meta.node, runnerId: 'runnerId' in answer ? answer.runnerId : undefined },
      });
    }
    if ('error' in answer) throw new NodeOperationError(answer.error.message);
    const headersOut = new Headers();
    for (const [name, value] of answer.headers) headersOut.append(name, value);
    const bytes = answer.body ? Buffer.from(answer.body, 'base64') : undefined;
    return new Response(NO_BODY.has(answer.status) ? null : bytes ? new Uint8Array(bytes) : null, { status: answer.status, headers: headersOut });
  };
}
