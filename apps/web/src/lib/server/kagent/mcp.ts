/**
 * An agent's tools for kagent: /api/mcp/agents/<id> (docs/a2a.md, "Landflow agents on kagent"). The agent deployed to kagent
 * binds this server (its RemoteMCPServer), so on kagent it has the tools it has here: the ones the runtime builds from the
 * deployed version (../agents/tools.ts), minus memory, run the same way, each in an `execute_tool {tool}` span.
 *
 * - **Who may call**: only the bearer token Landflow wrote to kagent's Secret when it deployed the agent; anything else is
 *   401, and an agent that isn't deployed is 404.
 * - **Approvals**: kagent pauses on the tools that need one (their binding has `requireApproval`), so a call that arrives
 *   here was approved. Sub-agents and remote agents that would pause again are refused (`approvals: deny`), as in a schedule.
 *   Claude Code binds a server whole, so on its runtime kagent gets two: `?tools=free` serves only the tools that run
 *   freely and `?tools=approval` only those it pauses on, so none can be called past the pause.
 * - **Sessions**: a call runs with a session of its own that isn't kept (kagent keeps the conversation); a sub-agent's
 *   child session is kept as usual.
 */
import { nanoid } from 'nanoid';
import type { Agent, AgentConfig } from '../../shared/agents';
import { newSession, runAgent } from '../agents/runtime';
import type { ToolContext } from '../agents/tools';
import { agentStore } from '../agents/store';
import { credentials } from '../credentials/vault';
import { bearerToken, jsonRpcError, McpServer, MCP_SERVER_VERSION, sameSecret, serveMcpEndpoint, textResult, unauthorized } from '../mcp/server';
import { traceToolCall } from '../telemetry';
import { deployedConfig, kagentTools } from './deploy';

export async function handleAgentMcpRequest(request: Request, agentId: string): Promise<Response> {
  const agent = agentStore.get(agentId);
  const deployed = agent && deployedConfig(agent);
  if (!agent?.kagent?.token || !deployed) return jsonRpcError(404, -32001, `No agent “${agentId}” is deployed to kagent`);
  let token: string;
  try {
    token = credentials.openSecret(agent.kagent.token);
  } catch (error) {
    return jsonRpcError(500, -32603, (error as Error).message);
  }
  if (!sameSecret(bearerToken(request), token)) return unauthorized('This endpoint takes the token Landflow wrote to kagent when it deployed the agent');
  const only = new URL(request.url).searchParams.get('tools');
  const part = only === 'free' || only === 'approval' ? only : undefined;
  return serveMcpEndpoint(`agent:${agentId}${part ? `:${part}` : ''}`, request, () => agentMcpServer(agent, deployed.config, deployed.version, request.signal, part));
}

function agentMcpServer(agent: Agent, config: AgentConfig, version: number, signal: AbortSignal, part?: 'free' | 'approval'): McpServer {
  const server = new McpServer(
    { name: 'landflow-agent', title: config.name, version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: `The tools of the Landflow agent “${config.name}” (version ${version}).` },
  );
  let listed: ReturnType<typeof kagentTools> | undefined;
  const tools = () =>
    (listed ??= kagentTools(agent, config)).then((set) => (part ? set.tools.filter((tool) => tool.requireApproval === (part === 'approval')) : set.tools));
  // Raw JSON schemas, so the low-level handlers rather than registerTool (which takes zod).
  server.server.setRequestHandler('tools/list', async () => ({
    tools: (await tools()).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: { ...tool.inputSchema, type: 'object' as const } })),
  }));
  server.server.setRequestHandler('tools/call', async (request) => {
    const tool = (await tools()).find((t) => t.name === request.params.name);
    if (!tool) return textResult(`The agent “${config.name}” has no tool ${request.params.name}`, true);
    const ctx = toolContext(agent, config, version, signal);
    try {
      const outcome = await traceToolCall({ agentId: agent.id, agentName: config.name, tool: tool.name, callId: `kagent_${nanoid(10)}`, kind: tool.kind }, () =>
        tool.invoke((request.params.arguments ?? {}) as Record<string, unknown>, ctx),
      );
      if (outcome.pause) return textResult(`${tool.label} waits for a person’s approval, which can’t be given on this path`, true);
      return textResult(outcome.output);
    } catch (error) {
      return textResult((error as Error).message, true);
    }
  });
  return server;
}

function toolContext(agent: Agent, config: AgentConfig, version: number, signal: AbortSignal): ToolContext {
  const self = { ...agent, ...config };
  const maxDepth = config.settings.maxDelegationDepth;
  return {
    agent: self,
    session: newSession(self, { source: 'api', userId: `kagent:${agent.kagent?.name ?? agent.id}`, version, title: 'kagent' }),
    depth: 0,
    maxDepth,
    runId: `ar_${nanoid(10)}`,
    signal,
    approvals: 'deny',
    async delegate(target, task) {
      const child = newSession(target, { source: 'agent', userId: `agent:${agent.id}`, version: target.published?.version ?? 'draft', title: task.slice(0, 80), parentAgentId: agent.id });
      const result = await runAgent({ agent: target, session: child, message: task, depth: 1, maxDepth, approvals: 'deny', signal });
      return { reply: result.reply, sessionId: child.id };
    },
  };
}
