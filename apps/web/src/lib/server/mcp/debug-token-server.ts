/**
 * The MCP server a debug token opens (docs/specs/19-debug-token.md): three read-only tools about ONE execution.
 *
 * It is a server of its own, not the instance server with a filter: `tools/list` shows three tools and every other name
 * is an unknown tool, so no later tool is reachable by forgetting a check. The tools are the instance server's own
 * (`explain_failure`, `get_run_trace` from ./debug-tools.ts, `get_execution`), wrapped so that every call
 *
 * 1. re-checks the token (not revoked or expired, under its use cap, its minter still allowed to read the workflow),
 * 2. needs the scope of the tool (`executions:read` for get_execution and explain_failure, `trace:read` for get_run_trace),
 * 3. refuses any execution id but the token's, with the same "not found" as for a missing one,
 * 4. is audited (`mcp.tool.call`) BEFORE it runs, and is refused if the event cannot be stored,
 * 5. returns text redacted of credential values, `$vars` values, external secrets and secret-named keys (`redactorFor`).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Workflow } from '@landflow/engine';
import type { ExecutionRecord } from '../../shared/types';
import { recordAudit } from '../audit';
import { recordDebugUse, verifyDebugToken, type DebugTokenRecord, type DebugTokenScope } from '../auth/debug-tokens';
import { liveExecution, publicUrl } from '../runner';
import { store } from '../store';
import { logger } from '../telemetry';
import { redactorFor, registerDebugTools } from './debug-tools';
import { MCP_SERVER_VERSION, McpServer, textResult } from './server';

/** The tools a debug token may call, and the scope each needs. Nothing else is registered. */
export const DEBUG_TOKEN_TOOLS: Record<string, DebugTokenScope> = {
  get_execution: 'executions:read',
  explain_failure: 'executions:read',
  get_run_trace: 'trace:read',
};

const INSTRUCTIONS = (executionId: string) =>
  `This server holds a read-only debug token for the execution “${executionId}” and nothing else. explain_failure is the first call: the failing node, its resolved parameters, a sample input, the upstream fields and what to check. get_run_trace pages the journal; get_execution has the node outputs (includeData). Credentials and $vars are redacted. It cannot change, run, retry or read anything but this execution.`;

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<CallToolResult> | CallToolResult;

export interface DebugTokenServerOptions {
  /** instanceServer's one-execution summary. */
  digest: (record: ExecutionRecord, includeData: boolean) => unknown;
}

/** `token` is the presented token (re-verified per call); `grant` what it was verified to be. */
export function debugTokenServer(token: string, grant: DebugTokenRecord, options: DebugTokenServerOptions): McpServer {
  const failure = (message: string) => textResult(message, true);
  const server = new McpServer({ name: 'landflow', title: 'Landflow · debug token', version: MCP_SERVER_VERSION }, { instructions: INSTRUCTIONS(grant.executionId) });

  const audit = (tool: string, outcome: 'success' | 'failure' | 'denied', details: Record<string, unknown> = {}): boolean => {
    try {
      return Boolean(
        recordAudit({
          action: 'mcp.tool.call',
          outcome,
          target: { type: 'execution', id: grant.executionId },
          summary: `${outcome === 'success' ? 'Debug token called' : outcome === 'denied' ? 'Debug token refused for' : 'Debug token failed in'} ${tool} on execution ${grant.executionId}`,
          details: { tool, via: 'debug-token', debugId: grant.id, mintedBy: grant.createdBy, executionId: grant.executionId, workflowId: grant.workflowId, scopes: grant.scopes, ...details },
          // The token is nobody: the event carries who minted it in its details, never as the actor.
          actor: 'anonymous',
        }),
      );
    } catch (error) {
      logger.warn('debug token audit failed', { error: (error as Error).message });
      return false;
    }
  };

  const guarded = (tool: string, scope: DebugTokenScope, run: Handler): Handler => async (args, extra) => {
    const checked = verifyDebugToken(token);
    if (!checked.ok || checked.record.id !== grant.id) {
      audit(tool, 'denied', { reason: checked.ok ? 'another token' : checked.reason });
      return failure('This debug token is no longer valid');
    }
    if (!checked.record.scopes.includes(scope)) {
      audit(tool, 'denied', { reason: 'scope', needs: scope });
      return failure(`This debug token lacks the “${scope}” scope`);
    }
    const id = typeof args.id === 'string' ? args.id : undefined;
    if (id !== grant.executionId) {
      audit(tool, 'denied', { reason: 'other execution', asked: id });
      return failure(`Execution ${id ?? '?'} not found`);
    }
    // The use is counted and audited before anything is read: no event, no data.
    if (!audit(tool, 'success')) return failure('The use of this debug token could not be audited, so it was refused');
    recordDebugUse(grant.id);
    let result: CallToolResult;
    try {
      result = await run(args, extra);
    } catch (error) {
      audit(tool, 'failure', { error: (error as Error).message });
      return failure((error as Error).message);
    }
    if (result.isError) audit(tool, 'failure', {});
    return result;
  };

  const record = (): ExecutionRecord | undefined => {
    const found = liveExecution(grant.executionId) ?? store.getExecution(grant.executionId);
    // The token names one execution of one workflow; a record of any other workflow is not served.
    return found && found.workflowId === grant.workflowId ? found : undefined;
  };

  server.registerTool(
    'get_execution',
    {
      title: 'Get the execution',
      description: 'The execution this token is for: status, error, what each node did (runs, output item counts, errors) and the last node\'s output. includeData adds every node\'s full input and output. Credentials and $vars are redacted.',
      inputSchema: z.object({ id: z.string().describe('Execution id (the one this token is for)'), includeData: z.boolean().optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    guarded('get_execution', DEBUG_TOKEN_TOOLS.get_execution, ((args: { includeData?: boolean }) => {
      const found = record();
      if (!found) return failure(`Execution ${grant.executionId} not found`);
      const workflow: Workflow | undefined = found.workflow ?? store.getWorkflow(found.workflowId);
      return textResult(redactorFor(workflow)(options.digest(found, Boolean(args.includeData))));
    }) as unknown as Handler) as never,
  );

  // explain_failure and get_run_trace are the instance server's tools, registered through a filter that names the three
  // allowed tools, wraps each in `guarded` and gives their access checks one answer: the token's execution and workflow.
  const only = (workflowId: string) => workflowId === grant.workflowId;
  const filter = {
    registerTool: (name: string, config: unknown, cb: Handler) => {
      const scope = DEBUG_TOKEN_TOOLS[name];
      if (!scope || name === 'get_execution') return undefined;
      return server.registerTool(name, config as never, guarded(name, scope, cb) as never);
    },
  } as unknown as McpServer;
  registerDebugTools(filter, {
    // No actor: the token is not a user. The checks below are what stands in for the project rules.
    denied: (workflowId, action) => (action === 'read' && only(workflowId) ? undefined : failure('Not allowed with a debug token')),
    inScope: only,
    json: (value) => textResult(value),
    failure,
    workflowUrl: (id) => `${publicUrl()}/workflows/${id}`,
    digest: options.digest,
  });

  return server;
}
