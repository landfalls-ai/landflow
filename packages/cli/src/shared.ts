/**
 * Helpers several commands share: reading JSON input, finding a workflow by id or name, turning credential
 * references by name into this host's ids, and the stable shapes of workflows and executions in JSON output.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { seg, type Client } from './client';
import type { Context } from './command';
import { CliError, usage } from './errors';

type Json = Record<string, unknown>;

/** The text of a file, or of stdin for `-`. */
export async function readInput(ctx: Context, path: string): Promise<string> {
  if (path === '-') return ctx.io.readStdin();
  try {
    return readFileSync(resolve(ctx.io.cwd, path), 'utf8');
  } catch (caught) {
    throw new CliError('io', `Can't read ${path}: ${(caught as NodeJS.ErrnoException).code ?? (caught as Error).message}`);
  }
}

export async function readJson(ctx: Context, path: string): Promise<unknown> {
  const text = await readInput(ctx, path);
  try {
    return JSON.parse(text);
  } catch (caught) {
    throw new CliError('io', `${path === '-' ? 'stdin' : path} isn't valid JSON: ${(caught as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  folderId: string | null;
  tags: string[];
  nodeCount: number;
  updatedAt: string | null;
}

/** The stable summary shape, from a list entry or a full workflow. */
export function workflowSummary(raw: Json): WorkflowSummary {
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    active: Boolean(raw.active),
    folderId: typeof raw.folderId === 'string' ? raw.folderId : null,
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    nodeCount: typeof raw.nodeCount === 'number' ? raw.nodeCount : Array.isArray(raw.nodes) ? raw.nodes.length : 0,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : null,
  };
}

/** A workflow by id, else by its exact name (case-insensitive); an ambiguous name is a usage error. */
export async function findWorkflow(client: Client, ref: string): Promise<Json> {
  const direct = await client.request<{ workflow?: Json }>('GET', `/api/workflows/${seg(ref)}`, { accept: [404] });
  if (direct.status === 200 && direct.body.workflow) return direct.body.workflow;
  const { workflows } = await client.get<{ workflows: Json[] }>('/api/workflows');
  const matches = workflows.filter((w) => String(w.name).toLowerCase() === ref.toLowerCase());
  if (matches.length > 1) throw usage(`${matches.length} workflows are named "${ref}": use an id (${matches.map((w) => w.id).join(', ')})`);
  if (!matches.length) throw new CliError('not_found', `No workflow with the id or name "${ref}"`, { status: 404 });
  return (await client.get<{ workflow: Json }>(`/api/workflows/${seg(String(matches[0].id))}`)).workflow;
}

/** A folder by id or name (for `--folder`). */
export async function findFolder(client: Client, ref: string): Promise<string> {
  const { folders } = await client.get<{ folders: Array<{ id: string; name: string }> }>('/api/folders');
  const found = folders.find((f) => f.id === ref) ?? folders.filter((f) => f.name.toLowerCase() === ref.toLowerCase()).at(0);
  if (!found) throw new CliError('not_found', `No folder with the id or name "${ref}"`, { status: 404 });
  return found.id;
}

/**
 * Credential references that name a credential (`{ name, type }`, as `export` and `sync` write them) → this host's
 * `{ id, name }`. A name the host doesn't have keeps an empty id (the node shows it as missing); returns warnings.
 */
export async function attachCredentialIds(client: Client, workflow: Json): Promise<string[]> {
  const nodes = Array.isArray(workflow.nodes) ? (workflow.nodes as Json[]) : [];
  const pending = nodes.flatMap((node) =>
    Object.entries((node.credentials as Record<string, Json> | undefined) ?? {})
      .filter(([, ref]) => ref && typeof ref === 'object' && typeof ref.id !== 'string')
      .map(([key, ref]) => ({ node, key, ref })),
  );
  if (!pending.length) return [];
  let saved: Array<{ id: string; name: string; type: string }> = [];
  const warnings: string[] = [];
  try {
    saved = (await client.get<{ credentials: Array<{ id: string; name: string; type: string }> }>('/api/credentials')).credentials ?? [];
  } catch (caught) {
    if (!(caught instanceof CliError) || (caught.code !== 'forbidden' && caught.code !== 'unauthorized')) throw caught;
    warnings.push('Credentials can’t be listed with this API key: credential references were left unresolved');
  }
  for (const { node, key, ref } of pending) {
    const nodeType = String(node.type ?? '');
    const type = typeof ref.type === 'string' ? ref.type : key.includes('.') ? key : `${nodeType.includes('.') ? nodeType.slice(0, nodeType.indexOf('.')) : 'core'}.${key}`;
    const name = String(ref.name ?? '');
    const match = saved.find((c) => c.type === type && c.name === name);
    if (!match && saved.length) warnings.push(`Credential “${name}” (${type}) isn't on this host: pick one in “${String(node.name)}”`);
    (node.credentials as Record<string, Json>)[key] = { id: match?.id ?? '', name: match?.name ?? name };
  }
  return warnings;
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

export interface ExecutionSummary {
  id: string;
  workflowId: string;
  workflowName: string;
  status: string;
  mode: string;
  startedAt: string;
  durationMs: number;
  error: { message: string; node: string | null } | null;
}

export interface ExecutionDetail extends ExecutionSummary {
  finishedAt: string | null;
  retryOf: string | null;
  waitingFor: { node: string; resume: string; until: string | null } | null;
  nodes: Array<{ id: string; name: string; status: string; runs: number; items: number; error: string | null }>;
  /** The last node's first output, as item JSON (at most 100 items). */
  output: unknown[];
}

const errorOf = (raw: Json): ExecutionSummary['error'] => {
  const error = raw.error as { message?: string; nodeName?: string } | undefined;
  return error?.message ? { message: error.message, node: error.nodeName ?? null } : null;
};

export function executionSummary(raw: Json): ExecutionSummary {
  return {
    id: String(raw.id ?? raw.executionId),
    workflowId: String(raw.workflowId ?? ''),
    workflowName: String(raw.workflowName ?? ''),
    status: String(raw.status ?? ''),
    mode: String(raw.mode ?? ''),
    startedAt: String(raw.startedAt ?? ''),
    durationMs: Number(raw.durationMs ?? 0),
    error: errorOf(raw),
  };
}

type Run = { status?: string; outputs?: Array<Array<{ json?: unknown }>>; error?: { message?: string } };

/** The stable detail shape of GET /api/executions/:id's record. `withData` adds the raw `runData`. */
export function executionDetail(raw: Json, withData = false): ExecutionDetail & { runData?: unknown } {
  const runData = (raw.runData as Record<string, Run[]> | undefined) ?? {};
  const names = (raw.nodeNames as Record<string, string> | undefined) ?? {};
  const order = [...new Set([...((raw.executionOrder as string[] | undefined) ?? []), ...Object.keys(runData)])].filter((id) => runData[id]);
  const nodes = order.map((id) => {
    const runs = runData[id];
    const last = runs.at(-1);
    return {
      id,
      name: names[id] ?? id,
      status: String(last?.status ?? 'unknown'),
      runs: runs.length,
      items: (last?.outputs ?? []).reduce((n, branch) => n + (branch?.length ?? 0), 0),
      error: last?.error?.message ?? null,
    };
  });
  const lastId = typeof raw.lastNodeId === 'string' ? raw.lastNodeId : undefined;
  const output = ((lastId && runData[lastId]?.at(-1)?.outputs?.[0]) || []).slice(0, 100).map((item) => item?.json ?? null);
  const wait = raw.wait as { nodeName?: string; resume?: string; until?: string } | undefined;
  return {
    ...executionSummary(raw),
    finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : null,
    retryOf: typeof raw.retryOf === 'string' ? raw.retryOf : null,
    waitingFor: raw.status === 'waiting' && wait ? { node: String(wait.nodeName ?? ''), resume: String(wait.resume ?? ''), until: wait.until ?? null } : null,
    nodes,
    output,
    ...(withData && { runData }),
  };
}

const RUNNING = new Set(['running', 'queued', 'new']);

/**
 * Poll an execution until it ends (success, error, canceled) or parks (waiting). `timeoutSeconds` 0 = no limit.
 * An execution that vanished after it started was not kept (the workflow's settings drop such runs).
 */
export async function waitForExecution(ctx: Context, id: string, timeoutSeconds = 0): Promise<ExecutionDetail> {
  const deadline = timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : Infinity;
  let delay = 100;
  for (;;) {
    const read = await ctx.client.request<{ execution?: Json }>('GET', `/api/executions/${seg(id)}`, { accept: [404] });
    if (read.status === 404) throw new CliError('not_found', `Execution ${id} finished but wasn't kept (the workflow's settings don't save such runs)`, { status: 404 });
    const execution = executionDetail(read.body.execution ?? {});
    if (!RUNNING.has(execution.status)) return execution;
    if (Date.now() + delay > deadline) throw new CliError('timeout', `Execution ${id} is still ${execution.status} after ${timeoutSeconds} s`, { details: { executionId: id, status: execution.status } });
    await ctx.io.sleep(delay);
    delay = Math.min(1000, Math.round(delay * 1.5));
  }
}

/** A finished execution that didn't succeed is a failure of `run --wait` (exit 1, the execution in `details`). */
export function failUnlessSucceeded(execution: ExecutionDetail) {
  if (execution.status === 'success' || execution.status === 'waiting') return;
  const reason = execution.error ? `: ${execution.error.message}${execution.error.node ? ` (in “${execution.error.node}”)` : ''}` : '';
  throw new CliError('execution_failed', `Execution ${execution.id} ended with status ${execution.status}${reason}`, { details: { execution } });
}

/** People's view of one execution. */
export function describeExecution(execution: ExecutionDetail, lines: (rows: ExecutionDetail['nodes']) => string): string {
  const head =
    execution.status === 'waiting' && execution.waitingFor
      ? `Execution ${execution.id} is waiting at “${execution.waitingFor.node}” (${execution.waitingFor.resume})`
      : `Execution ${execution.id} ${execution.status === 'success' ? 'succeeded' : `ended with status ${execution.status}`} in ${execution.durationMs} ms`;
  const parts = [head + (execution.error ? `\nError: ${execution.error.message}${execution.error.node ? ` (in “${execution.error.node}”)` : ''}` : '')];
  if (execution.nodes.length) parts.push(lines(execution.nodes));
  if (execution.output.length) parts.push(`Output (${execution.output.length} item${execution.output.length === 1 ? '' : 's'} from the last node):\n${JSON.stringify(execution.output.slice(0, 20), null, 2)}`);
  return parts.join('\n\n');
}
