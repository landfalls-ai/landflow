/** `run` and `executions list/get/retry/stop`. */
import { seg } from '../client';
import { flag, type Command, type Context } from '../command';
import { CliError, usage } from '../errors';
import { duration, fields, table, time } from '../output';
import { describeExecution, executionDetail, executionSummary, failUnlessSucceeded, findWorkflow, readJson, waitForExecution, type ExecutionDetail } from '../shared';

type Json = Record<string, unknown>;

const nodeTable = (rows: ExecutionDetail['nodes']) =>
  table(rows, [
    { label: 'node', value: (n) => n.name, max: 40 },
    { label: 'status', value: (n) => n.status },
    { label: 'runs', value: (n) => n.runs, align: 'right' },
    { label: 'items', value: (n) => n.items, align: 'right' },
    { label: 'error', value: (n) => n.error, max: 60 },
  ]);

/** The execution after `--wait`: the result, or an execution_failed error carrying it. */
async function finish(ctx: Context, executionId: string, extra: Json = {}) {
  const execution = await waitForExecution(ctx, executionId, Number(ctx.flags.timeout ?? 0));
  failUnlessSucceeded(execution);
  return { data: { ...extra, execution }, human: () => describeExecution(execution, nodeTable) };
}

export const run: Command = {
  name: 'run',
  summary: 'Run a workflow (by id or name), in the background or --wait for the result',
  usage: '<workflow> [--input <file|->] [--wait] [--timeout <seconds>]',
  details:
    'The input is a JSON object (one item) or an array of objects (items) for the start node: by default the manual, webhook, chat or schedule trigger.\nWith --wait the command exits 1 when the execution fails.',
  flags: {
    input: flag.string('JSON input for the start node, from a file or - for stdin', 'file|-', 'i'),
    wait: flag.boolean('Wait for the execution to finish and print it', 'w'),
    timeout: flag.number('With --wait: give up after this many seconds (exit 7)', 'seconds'),
    'start-node': flag.string('Start from this node (name or id) instead of the trigger', 'node'),
    'idempotency-key': flag.string('Run at most once per key (a repeat names the first execution)', 'key'),
  },
  args: { min: 1, max: 1 },
  async run(ctx) {
    // A key with only the `run` scope can't read workflows: then the argument is taken as the id.
    const workflow = await findWorkflow(ctx.client, ctx.args[0]).catch((caught: unknown) => {
      if (caught instanceof CliError && caught.code === 'forbidden') return { id: ctx.args[0] };
      throw caught;
    });
    const input = ctx.flags.input ? await readJson(ctx, String(ctx.flags.input)) : undefined;
    if (input !== undefined && (typeof input !== 'object' || input === null)) throw usage('The input must be a JSON object or an array of objects');
    const started = await ctx.client.post<{ executionId: string; status: string; duplicate?: boolean }>(`/api/workflows/${seg(String(workflow.id))}/execute`, {
      ...(input !== undefined && { input }),
      ...(ctx.flags['start-node'] ? { startNode: ctx.flags['start-node'] } : {}),
      ...(ctx.flags['idempotency-key'] ? { idempotencyKey: ctx.flags['idempotency-key'] } : {}),
    });
    const extra = { workflowId: String(workflow.id), ...(started.duplicate && { duplicate: true }) };
    if (ctx.flags.wait) return finish(ctx, started.executionId, extra);
    return {
      data: { executionId: started.executionId, ...extra, status: started.status },
      human: () => `Started ${started.executionId}${started.duplicate ? ' (an earlier run with this key)' : ''}. Follow it with: landflow executions get ${started.executionId}`,
    };
  },
};

export const list: Command = {
  name: 'executions list',
  summary: 'List recent executions, newest first',
  usage: '[--workflow <id|name>] [--status <status>] [--limit <n>]',
  flags: {
    workflow: flag.string('Only this workflow’s executions', 'id|name'),
    status: flag.string('Only this status: running, queued, waiting, success, error, canceled', 'status'),
    limit: flag.number('At most this many (default 20)'),
  },
  args: { max: 0 },
  async run(ctx) {
    const limit = Math.max(1, Math.min(1000, Number(ctx.flags.limit ?? 20)));
    const workflowId = ctx.flags.workflow ? String((await findWorkflow(ctx.client, String(ctx.flags.workflow))).id) : undefined;
    const status = ctx.flags.status ? String(ctx.flags.status) : undefined;
    const { executions } = await ctx.client.get<{ executions: Json[] }>('/api/executions', { workflowId, limit: status ? 1000 : limit });
    const rows = executions
      .map(executionSummary)
      .filter((e) => !status || e.status === status)
      .slice(0, limit);
    return {
      data: { executions: rows },
      human: () =>
        table(
          rows,
          [
            { label: 'id', value: (e) => e.id },
            { label: 'workflow', value: (e) => e.workflowName, max: 32 },
            { label: 'status', value: (e) => e.status },
            { label: 'mode', value: (e) => e.mode },
            { label: 'started', value: (e) => time(e.startedAt) },
            { label: 'duration', value: (e) => duration(e.durationMs), align: 'right' },
            { label: 'error', value: (e) => e.error?.message, max: 48 },
          ],
          'No executions.',
        ),
    };
  },
};

export const get: Command = {
  name: 'executions get',
  summary: 'Show an execution: status, each node’s runs and items, the last node’s output',
  usage: '<id> [--data]',
  flags: { data: flag.boolean('Include the raw run data of every node (--json)') },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const { execution: raw } = await ctx.client.get<{ execution: Json }>(`/api/executions/${seg(ctx.args[0])}`);
    const execution = executionDetail(raw, Boolean(ctx.flags.data));
    return {
      data: { execution },
      human: () =>
        `${fields([
          ['ID', execution.id],
          ['Workflow', `${execution.workflowName} (${execution.workflowId})`],
          ['Status', execution.status],
          ['Mode', execution.mode],
          ['Started', time(execution.startedAt)],
          ['Duration', duration(execution.durationMs)],
          ['Retry of', execution.retryOf],
        ])}\n\n${describeExecution(execution, nodeTable)}`,
    };
  },
};

export const retry: Command = {
  name: 'executions retry',
  summary: 'Retry a failed or canceled execution (from the failed node by default)',
  usage: '<id> [--from failed|start] [--version original|current] [--wait]',
  flags: {
    from: flag.string('failed (continue from the failed node) or start', 'failed|start'),
    version: flag.string('original (the version it ran) or current (the saved workflow)', 'original|current'),
    wait: flag.boolean('Wait for the retry to finish', 'w'),
    timeout: flag.number('With --wait: give up after this many seconds', 'seconds'),
  },
  args: { min: 1, max: 1 },
  async run(ctx) {
    const from = ctx.flags.from ?? 'failed';
    const version = ctx.flags.version ?? 'original';
    if (from !== 'failed' && from !== 'start') throw usage('--from is failed or start');
    if (version !== 'original' && version !== 'current') throw usage('--version is original or current');
    const { executionId } = await ctx.client.post<{ executionId: string }>(`/api/executions/${seg(ctx.args[0])}/retry`, { from, version });
    if (ctx.flags.wait) return finish(ctx, executionId, { retryOf: ctx.args[0] });
    return { data: { executionId, retryOf: ctx.args[0], status: 'running' }, human: () => `Started retry ${executionId} of ${ctx.args[0]}` };
  },
};

export const stop: Command = {
  name: 'executions stop',
  summary: 'Stop a running, waiting or queued execution, or every one with --all',
  usage: '<id> | --all',
  flags: { all: flag.boolean('Stop every execution and drop pending retries') },
  args: { max: 1 },
  async run(ctx) {
    if (ctx.flags.all) {
      if (ctx.args.length) throw usage('Give an execution id or --all, not both');
      const counts = await ctx.client.post<{ running: number; waiting: number; queued: number; retries: number }>('/api/executions/stop-all');
      const stopped = { running: counts.running ?? 0, waiting: counts.waiting ?? 0, queued: counts.queued ?? 0, retries: counts.retries ?? 0 };
      return { data: { all: true, stopped }, human: () => `Stopped ${stopped.running} running, ${stopped.waiting} waiting and ${stopped.queued} queued executions; dropped ${stopped.retries} retries` };
    }
    if (!ctx.args[0]) throw usage('Give an execution id, or --all');
    const result = await ctx.client.post<{ executionId: string; stopped: boolean; status: string }>(`/api/executions/${seg(ctx.args[0])}/stop`);
    if (!result.stopped) throw new CliError('conflict', `Execution ${ctx.args[0]} could not be stopped (status ${result.status})`, { details: result });
    return { data: { executionId: result.executionId, stopped: true, previousStatus: result.status }, human: () => `Stopped ${result.executionId} (was ${result.status})` };
  },
};

export const runCommands = [run, list, get, retry, stop];
