/**
 * Final live run, review: a tool set up as a read holds any call that is not one, decided per call on the parameters it would run
 * with. The model may offer `operation` and `query` per call (the plugin's input schema); a SQLite tool that "asks nothing first"
 * must not run DELETE.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentMessage, LanguageModel, ModelTurn, ToolSpec } from '@landflow/engine';
import type { Agent, AgentConfig } from '@/lib/shared/agents';
import type { IPlugin } from '@landflow/sdk';

type Step = (input: { system?: string; messages: AgentMessage[]; tools: ToolSpec[] }) => Partial<ModelTurn> | Promise<Partial<ModelTurn>>;
const script: Step[] = [];
const seen: Array<{ messages: AgentMessage[]; tools: ToolSpec[] }> = [];
vi.mock('@/lib/server/agents/models', () => ({
  OLLAMA_URL: 'http://127.0.0.1:11434',
  modelOptions: async () => [],
  agentModel: (): LanguageModel => ({
    provider: 'scripted', model: 'm',
    async generate(input) {
      seen.push({ messages: structuredClone(input.messages), tools: input.tools });
      const step = script.shift();
      if (!step) throw new Error('The script ran out of turns');
      return { text: '', toolCalls: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 }, ...(await step(input)) };
    },
  }),
}));

const { registry } = await import('@/lib/server/plugins/registry');
const { corePlugin } = await import('@/lib/server/nodes');
const { agentStore } = await import('@/lib/server/agents/store');
const { newSession, runAgent } = await import('@/lib/server/agents/runtime');
const { readOnlyCreds } = await import('@/lib/server/agents/tools');

const ran: Array<Record<string, unknown>> = [];
const op = (name: string, value: string, idempotent?: boolean) => ({ name, value, ...(idempotent && { idempotent }) });
const description = {
  name: 'sqlite', displayName: 'SQLite', description: 'SQLite', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], usableAsTool: true,
  toolInputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['select', 'executeQuery', 'deleteTable'] }, query: { type: 'string' }, table: { type: 'string' } }, required: ['operation'] },
  properties: [
    { name: 'operation', displayName: 'Operation', type: 'options', default: 'insert', options: [op('Delete', 'deleteTable'), op('Execute Query', 'executeQuery'), op('Insert', 'insert'), op('Select', 'select', true)] },
    { name: 'table', displayName: 'Table', type: 'string', default: '' },
    { name: 'query', displayName: 'Query', type: 'string', default: '' },
  ],
};
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin({ info: { id: 'databases', name: 'Databases', version: '1', description: 'x' }, nodes: [{ description, execute: async (ctx: { getNodeParameter(n: string, f?: unknown): unknown }) => { ran.push({ operation: ctx.getNodeParameter('operation'), query: ctx.getNodeParameter('query', '') }); return [[{ json: { ok: true } }]]; } }] } as unknown as IPlugin);
});
beforeEach(() => { script.length = 0; seen.length = 0; ran.length = 0; });

const reply = (text: string): Step => () => ({ text });
const call = (input: Record<string, unknown>): Step => () => ({ toolCalls: [{ id: 'c1', name: 'sqlite', input }] });
const agent = (parameters: Record<string, unknown>, extra: Partial<AgentConfig['tools'][number]> = {}): Agent =>
  agentStore.create({ name: 'Digest', instructions: 'x', model: { provider: 'ollama', model: 'm' }, tools: [{ id: 't1', type: 'node', name: 'sqlite', description: 'Sales', nodeType: 'databases.sqlite', parameters, ...extra } as never] });
const lastResult = () => { const last = seen.at(-1)!.messages.at(-1)!; return last.role === 'tool' ? last.results[0] : undefined; };
const go = (a: Agent, approvals?: 'deny') => runAgent({ agent: a, session: newSession(a, { source: 'test', userId: 'you', version: 'draft' }), message: 'x', ...(approvals && { approvals }) });

describe('a read tool with no approval', () => {
  const select = { operation: 'select', table: 'sales' };
  it.each([[{ operation: 'executeQuery', query: 'DELETE FROM t' }], [{ operation: 'deleteTable' }]])('holds %j and refuses it unattended', async (input) => {
    script.push(call(input), reply('ok'));
    const result = await go(agent(select), 'deny');
    expect(ran).toEqual([]);
    expect(lastResult()).toMatchObject({ isError: true, content: expect.stringContaining('read-only tool') });
    expect(result).toBeTruthy();
  });
  it('holds the call for a person when someone is there', async () => {
    script.push(call({ operation: 'executeQuery', query: 'DELETE FROM t' }));
    const result = await go(agent(select));
    expect(ran).toEqual([]);
    expect(result).toMatchObject({ reason: 'awaiting_approval' });
  });
  it('runs a SELECT', async () => {
    script.push(call({ operation: 'select', table: 'sales' }), reply('done'));
    await go(agent(select), 'deny');
    expect(ran).toEqual([expect.objectContaining({ operation: 'select' })]);
  });
  it('runs a stored read-only query tool when the call brings another SELECT, and holds one that writes', async () => {
    script.push(call({ query: 'SELECT 1' }), reply('done'));
    await go(agent({ operation: 'executeQuery', query: 'SELECT total FROM sales' }), 'deny');
    expect(ran).toHaveLength(1);
    script.push(call({ query: 'DELETE FROM sales' }), reply('done'));
    await go(agent({ operation: 'executeQuery', query: 'SELECT total FROM sales' }), 'deny');
    expect(ran).toHaveLength(1);
  });
  it('does not offer the operation in the tool’s input schema', async () => {
    script.push(reply('hi'));
    await go(agent(select), 'deny');
    const spec = seen[0].tools.find((t) => t.name === 'sqlite')!;
    expect(Object.keys((spec.inputSchema as { properties: object }).properties)).not.toContain('operation');
  });
  it('reaches a SQLite file through a read-only connection', () => {
    expect(readOnlyCreds({ sqlite: { path: '/x.db', createIfMissing: true } })).toEqual({ sqlite: { path: '/x.db', createIfMissing: false, readOnly: true } });
  });
});
