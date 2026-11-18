/** Review: "make sqlite read-only" changes the kept SQLite tool in place (its id, its credential), never a second tool beside it. */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { IPlugin } from '@landflow/sdk';
import type { AgentConfig } from '@/lib/shared/agents';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { startFakeModels } from './fake-ai-services';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-revise-place-ag4-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

const op = (name: string, value: string, idempotent?: boolean) => ({ name, value, ...(idempotent && { idempotent }) });
const description = {
  name: 'sqlite', displayName: 'SQLite', description: 'Read or change rows in SQLite', version: 1, kind: 'action', inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], usableAsTool: true, keywords: ['sqlite', 'database'],
  credentials: [{ name: 'sqlite', required: true }],
  properties: [
    { name: 'operation', displayName: 'Operation', type: 'options', default: 'insert', options: [op('Delete', 'deleteTable'), op('Execute Query', 'executeQuery'), op('Insert', 'insert'), op('Select', 'select', true)] },
    { name: 'table', displayName: 'Table', type: 'string', default: '' },
    { name: 'query', displayName: 'Query', type: 'string', default: '', displayOptions: { show: { operation: ['executeQuery'] } } },
  ],
};
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  registry.registerBuiltin({ info: { id: 'databases', name: 'Databases', version: '1', description: 'x' }, nodes: [{ description, execute: async () => [[]] }] } as unknown as IPlugin);
});

const post = (body: unknown) => import('@/app/api/agents/design/route').then(({ POST }) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));
const STEPS = 'Input: a question.\nSteps:\n1. Read the numbers with sqlite.\n2. Tools: sqlite; a person approves each change.';
const base = (): Partial<AgentConfig> => ({
  name: 'Sales digest', description: 'Reads sales.', instructions: STEPS, icon: 'bot', color: '#6366f1', model: { provider: 'ollama', model: 'qwen3-coder:30b' },
  tools: [{ id: 'tl_1', type: 'node', name: 'sqlite', description: 'Sales', nodeType: 'databases.sqlite', parameters: { operation: 'insert', table: '' }, credentials: { sqlite: { id: 'c1', name: 'Sales DB' } }, requireApproval: true } as never],
  skills: [], schedules: [], channels: [], memory: { crossSession: false }, settings: {} as never,
});

describe('a change that makes a kept tool read-only', () => {
  it('matches the tool name in any case and keeps an explicit approval on a tool that was a read', async () => {
    const fake = await startFakeModels({
      reply: (_p, body) => Array.isArray((body as { messages?: unknown })?.messages)
        ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Digest', instructions: STEPS, description: 'Reads sales.', model: 'ollama/qwen3-coder:30b', nodeTools: 'databases.sqlite' } }] }
        : { text: '', toolCalls: [] },
    });
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = fake.origin;
    try {
      const config = base();
      (config.tools![0] as never as { name: string; parameters: object }).name = 'SQLITE';
      (config.tools![0] as never as { parameters: object }).parameters = { operation: 'executeQuery', query: 'SELECT 1' };
      const body = (await (await post({ name: 'Sales digest', preview: true, base: { config }, change: 'Make sqlite a read-only tool for the sales database' })).json()) as { config: AgentConfig };
      expect(body.config.tools).toHaveLength(1);
      expect(body.config.tools[0]).toMatchObject({ id: 'tl_1', name: 'SQLITE', parameters: { operation: 'select' }, requireApproval: true });
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await fake.close();
    }
  });
  it('turns that tool in place: same id and credential, a read operation, no approval, one tool', async () => {
    const fake = await startFakeModels({
      reply: (_p, body) => Array.isArray((body as { messages?: unknown })?.messages)
        ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Digest', instructions: STEPS, description: 'Reads sales.', model: 'ollama/qwen3-coder:30b', nodeTools: 'databases.sqlite' } }] }
        : { text: '', toolCalls: [] },
    });
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = fake.origin;
    try {
      const body = (await (await post({ name: 'Sales digest', preview: true, base: { config: base() }, change: 'Make sqlite a read-only tool for the sales database' })).json()) as { config: AgentConfig };
      expect(body.config.tools).toHaveLength(1);
      expect(body.config.tools[0]).toMatchObject({ id: 'tl_1', name: 'sqlite', credentials: { sqlite: { id: 'c1' } }, parameters: { operation: 'select' } });
      expect((body.config.tools[0] as { requireApproval?: boolean }).requireApproval).toBeFalsy();
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await fake.close();
    }
  });
});

describe('a change that only gives access', () => {
  const run = async (change: string, kept: Record<string, unknown>) => {
    const fake = await startFakeModels({
      reply: (_p, body) => Array.isArray((body as { messages?: unknown })?.messages)
        ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Digest', instructions: STEPS, description: 'Reads sales.', model: 'ollama/qwen3-coder:30b', nodeTools: 'databases.sqlite' } }] }
        : { text: '', toolCalls: [] },
    });
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = fake.origin;
    try {
      const config = base();
      (config.tools![0] as never as { parameters: object; requireApproval?: boolean }).parameters = kept;
      delete (config.tools![0] as { requireApproval?: boolean }).requireApproval;
      // The caller's description names a write at SQLite (as a live agent's can), so the design proposes a write tool.
      return (await (await post({ name: 'Sales digest', description: 'Posts the summary and saves rows in SQLite.', preview: true, base: { config }, change })).json()) as { config: AgentConfig; changes: string[] };
    } finally {
      if (previous === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = previous;
      await fake.close();
    }
  };
  it('keeps the read tool a read: select does not become insert, and nothing asks first', async () => {
    const body = await run('Give the summary agent access to the sales database', { operation: 'select', table: 'sales' });
    expect(body.config.tools).toHaveLength(1);
    expect(body.config.tools[0]).toMatchObject({ id: 'tl_1', parameters: { operation: 'select' } });
    expect((body.config.tools[0] as { requireApproval?: boolean }).requireApproval).toBeFalsy();
    expect(body.changes.join(' ')).not.toMatch(/insert|asks first/i);
  });
  it('an explicit write verb may turn it into a write that asks first', async () => {
    const body = await run('Let the digest insert rows into the sales database', { operation: 'select', table: 'sales' });
    expect(body.config.tools.some((t) => 'parameters' in t && (t.parameters as { operation?: string }).operation === 'insert')).toBe(true);
  });
});
