/** Final live run, item 1: a SQLite tool added to READ data is a read (executeQuery, no approval); the card's tool is what is stored. */
import { describe, expect, it } from 'vitest';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { NodeToolConfig } from '@/lib/shared/agents';

const { cardTool } = await import('@/components/editor/spotlight/agent-ask');
const { draftFrom } = await import('@/lib/server/assistant/architect');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');

const op = (name: string, value: string, idempotent?: boolean) => ({ name, value, ...(idempotent && { idempotent }) });
const sqlite = {
  type: 'databases.sqlite', pluginId: 'databases', name: 'sqlite',
  descriptor: {
    displayName: 'SQLite', description: 'Query SQLite', name: 'sqlite', kind: 'action', group: [], version: 1, inputs: [{ type: 'main' }], outputs: [{ type: 'main' }], keywords: ['database', 'sql'],
    credentials: [{ name: 'sqlite', required: true }],
    properties: [
      { name: 'operation', displayName: 'Operation', type: 'options', default: 'insert', options: [op('Delete', 'deleteTable'), op('Execute Query', 'executeQuery'), op('Insert', 'insert'), op('Select', 'select', true), op('Update', 'update')] },
      { name: 'table', displayName: 'Table', type: 'string', default: '' },
      { name: 'query', displayName: 'Query', type: 'string', default: '', required: true, displayOptions: { show: { operation: ['executeQuery'] } } },
    ],
  },
} as unknown as NodeTypeInfo;

const design = (parameters: Record<string, unknown> | undefined, request: string) =>
  draftFrom({ name: 'Sales digest', role: 'Digest', instructions: 'Read the sales numbers.', tools: [{ type: 'node', nodeType: 'databases.sqlite', name: 'sqlite', description: 'Sales DB', ...(parameters && { parameters }) }] }, { types: [sqlite], actor: TEST_OWNER, known: '', request });
const tool = (config: { tools?: unknown[] }) => config.tools![0] as NodeToolConfig;

describe('a SQLite tool added to read data', () => {
  it.each([[{ operation: 'executeQuery' }], [{ operation: 'executeQuery', query: 'SELECT total FROM sales' }]])('a read the model chose as executeQuery stays executeQuery and asks nothing first (%j)', (given) => {
    const { config } = design(given, 'Give the digest access to the sales database so it reads the numbers.');
    expect(tool(config).parameters.operation).toBe('executeQuery');
    expect(tool(config).requireApproval).toBeFalsy();
  });
  it('a write the request asks for stays a write that asks first', () => {
    const { config } = design({ operation: 'insert', table: 'sales' }, 'Let the digest insert a row into SQLite.');
    expect(tool(config).parameters.operation).toBe('insert');
    expect(tool(config).requireApproval).toBe(true);
  });
});

describe('a tool left on the node default', () => {
  it('becomes the node’s Select read with no approval', () => {
    const { config } = design(undefined, 'Give the digest access to the sales database so it reads the numbers.');
    expect(tool(config).parameters.operation).toBe('select');
    expect(tool(config).requireApproval).toBeFalsy();
  });
});

describe('executeQuery', () => {
  it('SQL that changes data is a write that asks first', () => {
    const { config } = design({ operation: 'executeQuery', query: 'DELETE FROM sales' }, 'Let the digest run SQL in SQLite that deletes old sales rows.');
    expect(tool(config).requireApproval).toBe(true);
  });
});

describe('the card’s tool', () => {
  it('shows executeQuery with a read query as a read, and a write one as asking first', () => {
    const t = { id: 't', type: 'node', nodeType: 'databases.sqlite', name: 'sqlite', description: '', parameters: { operation: 'executeQuery', query: 'SELECT 1' } } as never;
    expect(cardTool(t)).toMatchObject({ operation: 'executeQuery', writes: false, requireApproval: false });
    expect(cardTool({ ...(t as object), parameters: { operation: 'insert' }, requireApproval: true } as never)).toMatchObject({ operation: 'insert', writes: true, requireApproval: true });
  });
});
