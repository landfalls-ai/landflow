/** Review: Apply replaces only the cases that asserted the old behaviour, in one all-or-nothing call; the explicit-write check needs a data object. */
import { describe, expect, it } from 'vitest';

const { agentStore } = await import('@/lib/server/agents/store');
const { addCase, listCases, replaceCases } = await import('@/lib/server/agents/eval-gate');
const route = await import('@/app/api/agents/[id]/eval-gate/route');
const { EXPLICIT_WRITE } = await import('@/lib/server/assistant/architect');

const patch = (id: string, body: unknown) => route.PATCH(new Request('http://localhost/x', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) } as never);

describe('replacing cases', () => {
  it('swaps the named cases for new ones and keeps the rest', async () => {
    const agent = agentStore.create({ name: 'A' });
    const old = addCase(agent.id, { input: 'text only', expected: 'only the text' });
    const keep = addCase(agent.id, { input: 'be friendly', expected: 'a friendly tone' });
    const res = await patch(agent.id, { remove: [old.id], add: [{ input: 'read rows', expected: 'uses the tool' }] });
    expect(res.status).toBe(200);
    expect(listCases(agent.id).map((c) => c.input)).toEqual(['be friendly', 'read rows']);
    expect(listCases(agent.id).some((c) => c.id === keep.id)).toBe(true);
  });
  it('a case that is no longer there changes nothing', async () => {
    const agent = agentStore.create({ name: 'B' });
    const one = addCase(agent.id, { input: 'one' });
    const res = await patch(agent.id, { remove: [one.id, 'ec_gone'], add: [{ input: 'new' }] });
    expect(res.status).toBe(409);
    expect(listCases(agent.id).map((c) => c.input)).toEqual(['one']);
  });
  it('a result over the cap changes nothing', () => {
    const agent = agentStore.create({ name: 'C' });
    for (let i = 0; i < 50; i++) addCase(agent.id, { input: `q${i}` });
    const first = listCases(agent.id)[0].id;
    expect(() => replaceCases(agent.id, [first], [{ input: 'a' }, { input: 'b' }])).toThrow(/at most 50/);
    expect(listCases(agent.id)).toHaveLength(50);
    expect(listCases(agent.id).some((c) => c.id === first)).toBe(true);
  });
  it('a failure half-way rolls everything back', () => {
    const agent = agentStore.create({ name: 'D' });
    const one = addCase(agent.id, { input: 'one' });
    expect(() => replaceCases(agent.id, [one.id], [{ input: 'fine' }, { input: '   ' }])).toThrow();
    expect(listCases(agent.id).map((c) => c.input)).toEqual(['one']);
  });
});

describe('EXPLICIT_WRITE', () => {
  it.each([
    ['insert rows into the sales table', true],
    ['write the totals to the sales database', true],
    ['save the summary to the database', true],
    ['delete old records', true],
    ['update the records every night', true],
    ['update me with a summary', false],
    ['save time on the weekly report', false],
    ['Update the agent so it can read the sales database', false],
    ['add rows of the table to the report', false],
    ['Give the summary agent access to the sales database', false],
    ['update its persona and instructions', false],
    ['Add read-only access to the database', false],
    ['add read access to the sales database', false],
    ['add access to the db', false],
    ['add SQLite to the db agent', false],
    ['write a query to the database', false],
    ['add a link to the table', false],
    ['add the results to the sales table', true],
  ])('“%s” → %s', (ask, expected) => expect(EXPLICIT_WRITE.test(ask)).toBe(expected));
});
