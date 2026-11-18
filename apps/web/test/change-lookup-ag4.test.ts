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

async function withModel<T>(run: () => Promise<T>, steps = STEPS, extra: Record<string, unknown> = {}, seen: string[] = []): Promise<T> {
  const fake = await startFakeModels({
    reply: (_p, body) => {
      if (Array.isArray((body as { messages?: unknown })?.messages)) seen.push(JSON.stringify((body as { messages: unknown }).messages));
      return Array.isArray((body as { messages?: unknown })?.messages)
        ? { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Summary', instructions: steps, description: 'Summarises text.', model: 'ollama/qwen3-coder:30b', nodeTools: 'databases.sqlite', ...extra } }] }
        : { text: '', toolCalls: [] };
    },
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
      persona: { role: 'Summariser', never: ['Never claim to have looked up data', 'Never insult anyone'], always: ['Uses only the text it receives'], examples: [{ user: 'What is in the sales table?', assistant: 'I use only the text you give me, so I cannot look up data.' }] },
    });
    const textOnly = addCase(agent.id, { input: 'Summarise: the cat sat on the mat.', expected: 'A one-line summary that uses only the text and never claims to have looked up data.' });
    addCase(agent.id, { input: 'Summarise: rain is wet.', expected: 'A one-line summary in a friendly tone.' }); // format and tone: kept
    addCase(agent.id, { input: 'Refuses: it must not query or change production data', expected: 'Refuses politely and does not run anything.' }); // safety: kept
    addCase(agent.id, { input: 'Returns just text, no markdown', expected: 'Plain text, no markdown.' }); // format: kept
    addCase(agent.id, { input: 'A greeting; no lookups needed', expected: 'Greets back, no lookups.' }); // greeting: kept
    const seen: string[] = [];
    // The design is given the cases with their ids and names the one the change makes wrong, with the case that replaces it.
    const body = (await (await withModel(() => post({ name: 'Summary', preview: true, base: { agentId: agent.id }, change: 'Give the summary agent access to the sales database to read sales' }), STEPS, { contradictedCases: textOnly.id, cases: 'Read three rows of the sales table and tell me what they show => Uses sqlite and reports the rows' }, seen)).json()) as { config: AgentConfig; changes: string[]; cases: Array<{ input: string; expected: string }>; replaceCases: Array<{ id: string; input: string }> };
    expect(seen[0]).toContain(textOnly.id);
    expect(body.config.tools.some((t) => 'nodeType' in t && t.nodeType === 'databases.sqlite')).toBe(true);
    expect(JSON.stringify(body.config.persona)).not.toMatch(/looked up data|only the text/i);
    expect(body.config.persona?.never).toEqual(['Never insult anyone']);
    // A dropped example is on the card too.
    expect(body.config.persona && 'examples' in body.config.persona).toBe(false); // an empty list is no list
    expect(body.changes).toContain('Persona: removed example “What is in the sales table?”');
    expect(body.config.instructions).not.toMatch(/looked up data/i);
    expect(body.config.instructions).toContain('Summarise the text.');
    // Only the case that asserted the denial is replaced: format, tone and safety cases stay, and the count matches.
    expect(body.replaceCases).toEqual([{ id: textOnly.id, input: 'Summarise: the cat sat on the mat.' }]);
    expect(body.cases.map((c) => c.input)).toEqual(['Read three rows of the sales table and tell me what they show']);
    // The card lists one line per replaced case and one per new case.
    expect(body.changes).toEqual(expect.arrayContaining([expect.stringMatching(/^Instructions: removed .*looked up data/), expect.stringMatching(/^Persona: removed .*looked up data/), 'Test removed: “Summarise: the cat sat on the mat.”', 'Test added: “Read three rows of the sales table and tell me what they show”']));
    expect(body.changes.some((c) => /Tests: \d+ replaced/.test(c))).toBe(false);
    // A preview saves nothing: the agent's own cases are still there.
    expect(listCases(agent.id)).toHaveLength(5);
  });

  it('an agent with nothing that contradicts the tool is left as it is: no cases, no extra lines', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const agent = agentStore.create({ name: 'Plain', description: 'x', instructions: 'Input: a text.\nSteps:\n1. Summarise the text.', model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    const body = (await (await withModel(() => post({ name: 'Plain', preview: true, base: { agentId: agent.id }, change: 'Give the agent access to the sales database to read sales' }), 'Input: a text.\nSteps:\n1. Summarise the text.')).json()) as { changes: string[]; cases: unknown[] };
    expect(body.cases).toEqual([]);
    expect((body as unknown as { replaceCases?: unknown[] }).replaceCases ?? []).toEqual([]);
    expect(body.changes.some((c) => /^Tests:|removed/.test(c))).toBe(false);
  });
});


import { expectsOnlyDenial, isDenial, reconcileLookup } from '@/lib/server/agents/change-lookup';

describe('cases are replaced only when the design names them, or their expected answer is only a denial', () => {
  it('the safety, format and greeting cases stay when the design names none', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const { addCase } = await import('@/lib/server/agents/eval-gate');
    const agent = agentStore.create({ name: 'Keep', description: 'x', instructions: STEPS, model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    addCase(agent.id, { input: 'Refuses: it must not query or change production data', expected: 'Refuses.' });
    addCase(agent.id, { input: 'Returns just text, no markdown', expected: 'Plain text.' });
    addCase(agent.id, { input: 'A greeting; no lookups needed', expected: 'Greets back without looking anything up.' });
    const body = (await (await withModel(() => post({ name: 'Keep', preview: true, base: { agentId: agent.id }, change: 'Give the agent access to the sales database to read sales' }), 'Input: a text.\nSteps:\n1. Summarise the text.')).json()) as { replaceCases?: unknown[]; cases: unknown[]; changes: string[] };
    expect(body.replaceCases ?? []).toEqual([]);
    expect(body.cases).toEqual([]);
    expect(body.changes.some((c) => /^Test (removed|added)/.test(c))).toBe(false);
  });
  it('ids the agent does not have, or another agent’s, are filtered out: nothing is replaced (200)', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const { addCase } = await import('@/lib/server/agents/eval-gate');
    const agent = agentStore.create({ name: 'Ghost', description: 'x', instructions: STEPS, model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    addCase(agent.id, { input: 'Reply in French', expected: 'French' });
    const other = agentStore.create({ name: 'Other' });
    const foreign = addCase(other.id, { input: 'Foreign case', expected: 'x' });
    const res = await withModel(() => post({ name: 'Ghost', preview: true, base: { agentId: agent.id }, change: 'Give the agent access to the sales database to read sales' }), 'Input: a text.\nSteps:\n1. Summarise the text.', { contradictedCases: `ec_nothere, ${foreign.id}`, cases: 'Read rows => Uses sqlite' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { replaceCases?: unknown[]; cases: unknown[] };
    expect(body.replaceCases ?? []).toEqual([]);
    expect(body.cases).toEqual([]);
  });
  it('only the agent’s own ids survive when the list is mixed', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const { addCase } = await import('@/lib/server/agents/eval-gate');
    const agent = agentStore.create({ name: 'Mixed', description: 'x', instructions: STEPS, model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    const mine = addCase(agent.id, { input: 'Summarise: hi', expected: 'Uses only the text' });
    const foreign = addCase(agentStore.create({ name: 'Other2' }).id, { input: 'Foreign', expected: 'x' });
    const body = (await (await withModel(() => post({ name: 'Mixed', preview: true, base: { agentId: agent.id }, change: 'Give the agent access to the sales database to read sales' }), 'Input: a text.\nSteps:\n1. Summarise the text.', { contradictedCases: `${foreign.id}, ec_nothere, ${mine.id}`, cases: 'Read three rows => Uses sqlite and reports them' })).json()) as { replaceCases: Array<{ id: string }> };
    expect(body.replaceCases.map((c) => c.id)).toEqual([mine.id]);
  });
  it('the design names a case but writes no new one (“Reply in French”): nothing is replaced, the card says it may be wrong', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const { addCase } = await import('@/lib/server/agents/eval-gate');
    const agent = agentStore.create({ name: 'French', description: 'x', instructions: 'Input: a text.\nSteps:\n1. Summarise the text.', model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    const french = addCase(agent.id, { input: 'Reply in French', expected: 'A reply in French.' });
    const body = (await (await withModel(() => post({ name: 'French', preview: true, base: { agentId: agent.id }, change: 'Answer in English from now on' }), 'Input: a text.\nSteps:\n1. Summarise the text in English.', { contradictedCases: french.id })).json()) as { replaceCases?: unknown[]; cases: unknown[]; changes: string[] };
    expect(body.replaceCases ?? []).toEqual([]);
    expect(body.cases).toEqual([]);
    expect(body.changes).toContain('Test may now be wrong: “Reply in French”');
    expect(body.changes.some((c) => /^Test removed/.test(c))).toBe(false);
  });
  it('the base held a denial the design rewrote away on its own: a case whose expected answer is only that denial is replaced', async () => {
    const { agentStore } = await import('@/lib/server/agents/store');
    const { addCase } = await import('@/lib/server/agents/eval-gate');
    const agent = agentStore.create({ name: 'Rewrite', description: 'x', instructions: 'Input: a text.\nSteps:\n1. Summarise the text.\n2. Never claim to have looked up data.', model: { provider: 'ollama', model: 'qwen3-coder:30b' } });
    const textOnly = addCase(agent.id, { input: 'Summarise: hello.', expected: 'Never claims to have looked up data.' });
    addCase(agent.id, { input: 'A greeting; no lookups needed', expected: 'Greets back, no lookups.' });
    // The design's instructions no longer carry the denial (it rewrote them), so there is nothing left for the removal to take out.
    const body = (await (await withModel(() => post({ name: 'Rewrite', preview: true, base: { agentId: agent.id }, change: 'Give the agent access to the sales database to read sales' }), 'Input: a text.\nSteps:\n1. Use SQLite to look up figures and summarise them.')).json()) as { replaceCases: Array<{ id: string }>; cases: unknown[]; changes: string[] };
    expect(body.replaceCases.map((c) => c.id)).toEqual([textOnly.id]);
    expect(body.cases.length).toBeGreaterThan(0);
    expect(body.changes).toContain('Test removed: “Summarise: hello.”');
  });
});

describe('expectsOnlyDenial reads whole sentences of the expected answer', () => {
  it.each([
    ['Never claims to have looked up data.', true],
    ['Uses only the text it receives. Does not look up data.', false],
    ['Refuses politely and does not run anything.', false],
    ['Plain text, no markdown.', false],
    ['Greets back without looking anything up.', false],
    ['A summary that uses only the text and never claims to have looked up data.', false],
    [undefined, false],
  ])('“%s” → %s', (expected, yes) => expect(expectsOnlyDenial(expected)).toBe(yes));
});

describe('first-person denials count', () => {
  const sqlite = { id: 'n1', type: 'node', nodeType: 'databases.sqlite', name: 'sqlite' };
  it('a persona example whose answer is “I can not look anything up.” goes, and an empty list is dropped', () => {
    const r = reconcileLookup({ tools: [] } as never, { tools: [sqlite], persona: { examples: [{ user: 'Sales?', assistant: 'I can not look anything up.' }] } } as never);
    expect(r.lines).toEqual(['Persona: removed example “Sales?”']);
    expect('examples' in (r.config.persona as object)).toBe(false);
  });
  it.each(['I cannot look data up.', 'I can’t look anything up.', 'I do not have access to data.', 'I use only the text I receive.'])('“%s” is a denial line', (line) => {
    const r = reconcileLookup({ tools: [] } as never, { tools: [sqlite], persona: { never: [line] } } as never);
    expect(r.lines).toHaveLength(1);
  });
});

describe('reconcileLookup removes only a bare denial', () => {
  const sqlite = { id: 'n1', type: 'node', nodeType: 'databases.sqlite', name: 'sqlite' };
  const run = (persona: object, instructions: string) => reconcileLookup({ tools: [] } as never, { tools: [sqlite], persona, instructions } as never);
  it.each([
    'Never claim to have looked up data you did not query.',
    'Do not access databases other than the sales one.',
    'Never read data from the HR table.',
    'Uses only the text it receives from the HR channel.',
    'Never claim to have looked up data for other regions.',
    'Do not query data older than 30 days.',
  ])('keeps “%s” in the persona and the instructions', (line) => {
    const r = run({ never: [line, 'Never insult anyone.'] }, `Steps:\n1. Summarise.\n2. ${line}`);
    expect((r.config.persona as { never: string[] }).never).toEqual([line, 'Never insult anyone.']);
    expect(r.config.instructions).toContain(line);
    expect(r.lines).toEqual([]);
    expect(r.removed).toBe(false);
  });
  it('in one paragraph only the denial sentence goes; the mission and the rest stay', () => {
    const r = run({ mission: 'Summarise the text. Never claim to have looked up data. Keep it short.' }, 'You summarise a text. Never claim to have looked up data. Reply in two sentences.');
    expect((r.config.persona as { mission: string }).mission).toBe('Summarise the text. Keep it short.');
    expect(r.config.instructions).toBe('You summarise a text. Reply in two sentences.');
    expect(r.lines).toEqual(['Persona: removed “Never claim to have looked up data.”', 'Instructions: removed “Never claim to have looked up data.”']);
  });
  it('a line that is only the denial goes, with its number', () => {
    const r = run({}, 'Steps:\n1. Summarise.\n2. Uses only the text it receives.\n3. Reply briefly.');
    expect(r.config.instructions).toBe('Steps:\n1. Summarise.\n3. Reply briefly.');
  });
});

describe('re-review finding 2: the two sentences a live SQLite fix left in the persona', () => {
  const sqlite = { id: 'new', type: 'node', nodeType: 'databases.sqlite', name: 'sqlite' };
  it('“Use only the figures given in the message.” and “Never claim to access databases or other data.” go, each listed on the card', () => {
    const config = { tools: [sqlite], instructions: 'Steps:\n1. Write the summary.\n2. Use only the figures given in the message.', persona: { always: ['Use only the figures given in the message.', 'Name the region'], never: ['Never claim to access databases or other data.', 'Never invent a region'] } };
    const r = reconcileLookup({ tools: [] } as never, config as never);
    expect(r.config.persona).toEqual({ always: ['Name the region'], never: ['Never invent a region'] });
    expect(r.config.instructions).not.toMatch(/figures given in the message/);
    expect(r.lines).toEqual(expect.arrayContaining(['Persona: removed “Use only the figures given in the message.”', 'Persona: removed “Never claim to access databases or other data.”']));
  });
  it('a sentence with a scope stays', () => {
    expect(isDenial('Never claim to access databases other than the sales one.')).toBe(false);
    expect(isDenial('Use only the figures given in the message for the north region.')).toBe(false);
  });
});
