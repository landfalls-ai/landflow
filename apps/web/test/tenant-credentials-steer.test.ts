/**
 * Wave ag4 carryover (the integrator's live pass, S3): "Create an agent that answers questions about our sales numbers
 * from the sales database." with a SQLite credential named Sales DB made Spotlight design a Postgres tool ("pick a
 * postgres credential (none yet …)"). The person's credentials now steer the choice: of two nodes that cover the words as
 * well, the one a credential of theirs fits ranks first in list_tool_nodes, and the architect's brief lists the credentials
 * (names and types only) and marks the matched nodes they fit. Nothing is picked for the person.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const { prepare, addScenarioPlugins } = await import('./spotlight-scenarios/harness');
const { registry } = await import('@/lib/server/plugins/registry');
const { credentials } = await import('@/lib/server/credentials/vault');
const { TEST_OWNER } = await import('@/lib/server/auth/test-bypass');
const { designBrief } = await import('@/lib/server/assistant/architect');
const { catalogToolNodes } = await import('@/lib/server/assistant/tenant-catalog');
const { tenantTool } = await import('@/lib/server/assistant/tenant-tools');

const SECRET = 'steer-made-up-not-a-secret';
let salesId = '';

beforeAll(async () => {
  prepare();
  await addScenarioPlugins({ start: { plugins: ['databases'] } }, 'unit');
});
afterAll(() => {
  if (salesId) credentials.delete(salesId);
});

describe('the person’s credentials steer the node Spotlight picks', () => {
  it('ranks the node a credential fits first, and the brief lists the credentials and marks the node', async () => {
    const query = 'answers questions about our sales numbers from the sales database';
    const before = catalogToolNodes(TEST_OWNER, { query }).map((n) => n.nodeType);
    expect(before).toEqual(expect.arrayContaining(['databases.postgres', 'databases.sqlite']));

    salesId = credentials.create({ name: 'Sales DB', type: 'databases.sqlite', data: { database: `/tmp/${SECRET}.db` } } as never).id;
    const after = catalogToolNodes(TEST_OWNER, { query }).map((n) => n.nodeType);
    expect(after.indexOf('databases.sqlite')).toBeLessThan(after.indexOf('databases.postgres'));
    // list_tool_nodes (the chat's and MCP's) answers in the same order, naming the credential, never its data.
    const listed = await tenantTool('list_tool_nodes', { query }, { actor: TEST_OWNER });
    expect(listed.text.indexOf('databases.sqlite')).toBeLessThan(listed.text.indexOf('databases.postgres'));
    expect(listed.text).toContain('Sales DB');
    expect(listed.text).not.toContain(SECRET);

    const types = registry.nodeTypes();
    const brief = designBrief({ name: 'Sales analyst', description: 'Answers questions about our sales numbers from the sales database', instructions: '' }, { types, actor: TEST_OWNER });
    expect(brief).toContain('Credentials the person has');
    expect(brief).toContain('Sales DB (databases.sqlite)');
    expect(brief).toMatch(/databases\.sqlite \(SQLite\)[^;]*works with your credential “Sales DB”/);
    const nodes = brief.split('\n').find((l) => l.startsWith('Nodes that matched'))!;
    if (nodes.includes('databases.postgres')) expect(nodes.indexOf('databases.sqlite')).toBeLessThan(nodes.indexOf('databases.postgres'));
    expect(brief).not.toContain(SECRET);
  });

  it('with no credential the brief says so', () => {
    const brief = designBrief({ name: 'X', description: 'reads a database', instructions: '' }, { types: registry.nodeTypes() });
    expect(brief).toContain('Credentials the person has: none yet.');
  });
});
