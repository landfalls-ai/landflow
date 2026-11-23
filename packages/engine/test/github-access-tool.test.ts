/**
 * The GitHub Access node attached to an agent's tool slot, through the engine's own nodeAsTool: the model supplies
 * arguments that override node parameters, so a node set up to read must still refuse to write when the model asks.
 * No GitHub is reachable here: a write that got past the guard would fail on the missing credential or the network,
 * and the test checks it failed on the guard instead.
 */
import { describe, expect, it } from 'vitest';
import { defineNode, type INodeType } from '@landflow/sdk';
import { executeWorkflow, inProcessNodeType, type AgentTool, type NodeTypeResolver, type Workflow, type WorkflowConnection, type WorkflowNode } from '../src';
import { GitHubAccess } from '../../../plugins/github/src/nodes/github-access';

const main = [{ type: 'main' as const }];
const trigger = defineNode({
  description: { name: 'trigger', displayName: 'Trigger', description: '', version: 1, kind: 'trigger', inputs: [], outputs: main, properties: [] },
  execute: (ctx) => [ctx.getInputData()],
});
/** Calls the tool it is wired to with the arguments a model could send, and reports what came back. */
const caller = defineNode({
  description: { name: 'caller', displayName: 'Caller', description: '', version: 1, kind: 'action', outputs: main, inputs: [...main, { type: 'ai_tool' }], properties: [] },
  async execute(ctx) {
    const [tool] = await ctx.getInputConnectionData!<AgentTool>('ai_tool');
    const outcomes: Array<{ args: unknown; error?: string; result?: unknown }> = [];
    const attempts = [
      { operation: 'add', username: 'bob' },
      { operation: 'remove', username: 'bob' },
      { resource: 'orgMembership', operation: 'invite', username: 'bob', orgRole: 'admin' },
      { resource: 'repoCollaborator', operation: 'add', owner: 'acme', repository: 'widgets', username: 'bob', permission: 'admin' },
    ];
    for (const args of attempts) {
      try {
        outcomes.push({ args, result: await tool.invoke(args) });
      } catch (error) {
        outcomes.push({ args, error: (error as Error).message });
      }
    }
    return [[{ json: { outcomes, schema: tool.inputSchema } as never }]];
  },
});

const registry: Record<string, INodeType> = { trigger, caller, access: GitHubAccess };
const resolver: NodeTypeResolver = {
  resolve(type) {
    const node = registry[type.replace(/^t\./, '')];
    return node ? inProcessNodeType('t', node) : { error: `Unknown node type "${type}"` };
  },
};
const n = (id: string, type: string, parameters: Record<string, unknown> = {}): WorkflowNode => ({ id, name: id, type: `t.${type}`, typeVersion: 1, position: [0, 0], parameters });
const c = (source: string, target: string, targetIndex = 0, type: WorkflowConnection['type'] = 'main'): WorkflowConnection => ({ id: `${source}-${target}-${targetIndex}`, type, source, sourceIndex: 0, target, targetIndex });

describe('GitHub Access as an agent tool', () => {
  it('refuses every write the model asks for, even over a read configuration, before any credential or network use', async () => {
    const workflow: Workflow = {
      id: 'wf',
      name: 'Tool',
      nodes: [n('a', 'trigger'), n('caller', 'caller'), n('access', 'access', { resource: 'teamMembership', operation: 'get', org: 'acme', teamSlug: 'platform', username: 'alice' })],
      connections: [c('a', 'caller'), c('access', 'caller', 1, 'ai_tool')],
    };
    const result = await executeWorkflow({ workflow, resolver, executionId: 'ex', mode: 'manual' });
    expect(result.status).toBe('success');
    const out = result.runData.caller[0].outputs[0][0].json as { outcomes: Array<{ error?: string; result?: unknown }> };
    expect(out.outcomes).toHaveLength(4);
    for (const outcome of out.outcomes) expect(outcome.error ?? JSON.stringify(outcome.result)).toMatch(/not allowed as an agent tool/);
  });
});
