/** Final live run 2, item 1: an agent fix that adds a data tool removes the lines saying the agent looks nothing up, and replaces the text-only cases. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { IPlugin } from '@landflow/sdk';
import type { AgentConfig } from '@/lib/shared/agents';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { startFakeModels } from './fake-ai-services';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-change-lookup-ag4-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const op = (name: string, value: string, idempotent?: boolean) => ({ name, value, ...(idempotent && { idempotent }) });
const description = {
  name: 'sqlite', displayName: 'SQLite', description: 'Read or change rows in SQLite', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], usableAsTool: true, keywords: ['sqlite', 'database'],
  credentials: [{ name: 'sqlite', required: true }],
  properties: [
    { name: 'operation', displayName: 'Operation', type: 'options', default: 'insert', options: [op('Delete', 'deleteTable'), op('Execute Query', 'executeQuery'), op('Insert', 'insert'), op('Select', 'select', true)] },
    { name: 'table', displayName: 'Table', type: 'string', default: '' },
  ],
};
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin({ info: { id: 'databases', name: 'Databases', version: '1', description: 'x' }, nodes: [{ description, execute: async () => [[]] }] } as unknown as IPlugin);
});

const post = (body: unknown) => import('@/app/api/agents/design/route').then(({ POST }) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
const STEPS = 'Input: a text.\nSteps:\n1. Summarise the text.\n2. Never claim to have looked up data.';

async function withModel<T>(run: () => Promise<T>, steps = STEPS): Promise<T> {
  const fake = await startFakeModels({
    reply: (_p, body) => Array.isArray((body as { messages?: unknown })?.messages)
      ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Summary', instructions: steps, description: 'Summarises text.', model: 'ollama/qwen3-coder:30b', nodeTools: 'databases.sqlite' } }] }
      : { text: '', toolCalls: [] },
  });
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = fake.origin;
  try { return await run(); } finally { if (previous === undefined) delete process.env.OLLAMA_URL; else process.env.OLLAMA_URL = previous; await fake.close(); }
}

describe('an agent fix that adds SQLite to a text-only agent', () => {
  it('drops “Never claim to have looked up data”, replaces the text-only cases and says so on the card', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const { addCase, listCases } = await import('@/lib/server/agents/eval-gate');
    const agent = agentStore.create({
      name: 'Summary', description: 'Summarises text.', instructions: STEPS, model: { provider: 'ollama', model: 'qwen3-coder:30b' },
      persona: { role: 'Summariser', never: ['Never claim to have looked up data', 'Never insult anyone'], always: ['Uses only the text it receives'] },
    });
    addCase(agent.id, { input: 'Summarise: the cat sat on the mat.', expected: 'A one-line summary of the text only.' });
    addCase(agent.id, { input: 'Summarise: rain is wet.', expected: 'A one-line summary.' });
    const body = (await (await withModel(() => post({ name: 'Summary', preview: true, base: { agentId: agent.id }, change: 'Give the summary agent access to the sales database to read sales' }))).json()) as { config: AgentConfig; changes: string[]; cases: Array<{ input: string; expected: string }> };
    expect(body.config.tools.some((t) => 'nodeType' in t && t.nodeType === 'databases.sqlite')).toBe(true);
    expect(JSON.stringify(body.config.persona)).not.toMatch(/looked up data|only the text/i);
    expect(body.config.persona?.never).toEqual(['Never insult anyone']);
    expect(body.config.instructions).not.toMatch(/looked up data/i);
    expect(body.config.instructions).toContain('Summarise the text.');
    expect(body.cases).toHaveLength(2);
    expect(body.cases[0].input).toMatch(/sales by region/);
    expect(body.changes).toEqual(expect.arrayContaining([expect.stringMatching(/^Instructions: removed .*looked up data/), expect.stringMatching(/^Persona: removed .*looked up data/), 'Tests: 2 replaced']));
    // A preview saves nothing: the agent's own cases are still there.
    expect(listCases(agent.id)).toHaveLength(2);
  });

  it('an agent with nothing that contradicts the tool is left as it is: no cases, no extra lines', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const agent = agentStore.create({ name: 'Plain', description: 'x', instructions: 'Input: a text.\nSteps:\n1. Summarise the text.', model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    const body = (await (await withModel(() => post({ name: 'Plain', preview: true, base: { agentId: agent.id }, change: 'Give the agent access to the sales database to read sales' }), 'Input: a text.\nSteps:\n1. Summarise the text.')).json()) as { changes: string[]; cases: unknown[] };
    expect(body.cases).toEqual([]);
    expect(body.changes.some((c) => /^Tests:|removed/.test(c))).toBe(false);
  });
});
