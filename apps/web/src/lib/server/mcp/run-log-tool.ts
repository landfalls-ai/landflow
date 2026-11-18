/**
 * `get_run_log` on the instance MCP server (wave ag4, AG20): what Spotlight reads of a run to fix it, for any MCP client.
 * The same `runLog` Spotlight's chat calls in-process; the caller sees only runs of workflows they may read.
 */
import { z } from 'zod';
import type { CallToolResult, McpServer } from '@modelcontextprotocol/server';
import { runLog } from '../assistant/run-log';
import { liveExecution } from '../runner';
import { store } from '../store';
import type { Actor } from '../projects/access';

export interface RunLogToolContext {
  actor?: Actor;
  inScope: (workflowId: string) => boolean;
  json: (value: unknown) => CallToolResult;
  failure: (message: string) => CallToolResult;
}

export function registerRunLogTool(server: McpServer, ctx: RunLogToolContext) {
  server.registerTool(
    'get_run_log',
    {
      title: 'Get the log of a run',
      description:
        'Everything needed to fix a failed run: each node\'s status, error (an HTTP node\'s status code and the response body\'s first 400 characters), up to 3 input and output items, the plugin\'s log lines, and for a Run an Agent node the agent\'s tool calls in order and its reply. Name an execution, or a workflow for its latest run. Credentials and secrets are redacted.',
      inputSchema: z.object({ workflowId: z.string().optional().describe('The workflow (its latest execution when no id is given)'), executionId: z.string().optional().describe('Execution id') }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ workflowId, executionId }) => {
      if (!workflowId && !executionId) return ctx.failure('Give an executionId or a workflowId');
      const owner = workflowId ?? (executionId ? (liveExecution(executionId) ?? (await store.loadExecution(executionId)))?.workflowId : undefined);
      if (owner && !ctx.inScope(owner)) return ctx.failure(executionId ? `Execution ${executionId} not found` : `Workflow ${owner} not found`);
      const log = await runLog(ctx.actor, { workflowId, executionId });
      return log ? ctx.json(log) : ctx.failure(executionId ? `Execution ${executionId} not found` : `No run of workflow ${workflowId} found`);
    },
  );
}
