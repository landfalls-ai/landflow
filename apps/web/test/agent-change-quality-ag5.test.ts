/**
 * AG24 (wave ag5, items 2 to 4 and the carried knowledge cases): an agent change that is right. Revised instructions read as sentences
 * (the live garble *1. read-only SELECT) to read…* came from cutting a clause at a comma inside brackets); the cases that replace a
 * data agent's make it use its tool (no figure in the question that the answer repeats, never a removed case again, a knowledge
 * agent's name only what its folder holds); and a tool the session added (`keep`) is never removed. The design model and the case
 * writer are scripted on a local fake; nothing leaves this machine.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { IPlugin } from '@landflow/sdk';
import type { AgentConfig } from '@/lib/shared/agents';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { startFakeModels } from './fake-ai-services';

Object.assign(process.env, { LANDFLOW_DATA_DIR: mkdtempSync(join(tmpdir(), 'landflow-change-quality-ag5-')), LANDFLOW_REGISTRY_GRPC_PORT: 'off', LANDFLOW_SCAN_ON_START: 'false', LANDFLOW_PLUGINS: '' });

// A knowledge base whose folder holds one document: the failover runbook.
vi.mock('@/lib/server/agents/knowledge', async (original) => ({ ...(await original<typeof import('@/lib/server/agents/knowledge')>()), listKnowledgeDocuments: async () => ({ documents: [{ documentId: 'd1', fileName: 'failover-runbook.md', chunks: 3 }], otherChunks: 0 }) }));

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

const architectApi = await import('@/lib/server/assistant/architect');
const { nameOnlyOwnTools, readsAsSentence, wholeSentences } = architectApi;
const { checkCases, figuresOf } = await import('@/lib/server/agents/case-rules');
const post = (body: unknown) => import('@/app/api/agents/design/route').then(({ POST }) => POST(new Request('http://localhost/api/agents/design', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })));

interface Script {
  /** The design's propose_design arguments, besides the summary. */
  design: Record<string, unknown>;
  /** What the case writer answers when it is asked again (one case per line). */
  again?: string;
  asked?: string[];
}
async function withModel<T>(script: Script, run: () => Promise<T>): Promise<T> {
  const fake = await startFakeModels({
    reply: (_p, body) => {
      const messages = (body as { messages?: unknown })?.messages;
      if (!Array.isArray(messages)) return { text: '', toolCalls: [] };
      const sent = JSON.stringify(body);
      if (sent.includes('You write test cases')) {
        script.asked?.push(sent);
        return { text: script.again ?? '', toolCalls: [] };
      }
      return { text: '', toolCalls: [{ id: 'c1', name: 'propose_design', arguments: { summary: 'x', role: 'Writer', description: 'Writes the summary.', model: 'ollama/qwen3-coder:30b', ...script.design } }] };
    },
  });
  const previous = process.env.OLLAMA_URL;
  process.env.OLLAMA_URL = fake.origin;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_URL;
    else process.env.OLLAMA_URL = previous;
    await fake.close();
  }
}

const STEPS = 'Input: a request.\nSteps:\n1. Write the summary from the text.\nOutput: a short summary.';
const writer = async (cases: Array<{ input: string; expected: string }>, extra: Partial<AgentConfig> = {}) => {
  const { agentStore } = await import('@/lib/server/agents/store');
  const { addCase } = await import('@/lib/server/agents/eval-gate');
  const agent = agentStore.create({ name: 'Short writer', description: 'Writes the summary.', instructions: STEPS, model: { provider: 'ollama', model: 'qwen3-coder:30b' }, ...extra });
  return { agent, cases: cases.map((c) => addCase(agent.id, c)) };
};
type Body = { config: AgentConfig; changes: string[]; dropped: string[]; cases: Array<{ input: string; expected: string }>; replaceCases?: Array<{ id: string; input: string }> };

describe('revised instructions read as sentences (item 3)', () => {
  // Shaped from the roadmap's quote (*1. read-only SELECT) to read…*): the base's step names the tool and puts a comma inside its brackets.
  const BASE = "Input: a request.\nSteps:\n1. Use sqlite (a single read-only SELECT, no writes) to read last month's sales by region.\n2. Write a short summary.\nOutput: a summary.";

  it('a clause cut at a comma inside brackets no longer leaves a fragment', () => {
    const { text } = nameOnlyOwnTools(BASE, [{ name: 'sales_read' }], { foreign: ['sqlite'], nodeTypes: {}, catalog: [] });
    expect(text).not.toMatch(/read-only SELECT\)|no writes\)/);
    expect(text.split('\n').filter((l) => /^\d+\./.test(l)).every((l) => readsAsSentence(l))).toBe(true);
    expect(text).toContain('1. Write a short summary.');
    expect(text.split('\n').filter((l) => /^1\./.test(l))).toHaveLength(1);
  });

  it('a clause that can be cut cleanly is cut, and the sentence reads whole', () => {
    const { text } = nameOnlyOwnTools('Input: a request.\nSteps:\n1. Call sqlite, then write the summary (short, plain) for the person.\nOutput: a summary.', [{ name: 'sales_read' }], { foreign: ['sqlite'], nodeTypes: {}, catalog: [] });
    expect(text).toContain('1. write the summary (short, plain) for the person.');
  });

  it('readsAsSentence refuses unbalanced brackets or backticks, a step starting with ")" or a fragment, a doubled number and a cut clause', () => {
    for (const bad of ['1. read-only SELECT) to read last month’s sales.', '2. Use `sqlite to read sales.', '3. ) to read sales.', '1. 2. Do it.', '4. Read the sales and', '2. no writes) to read last month.', '5. (read the sales.']) expect(readsAsSentence(bad), bad).toBe(false);
    for (const good of ['1. Use sqlite (read-only SELECT) to read last month’s sales by region.', 'Steps:', '2. Write a short summary…', 'Input: a request.', '3. When asked, call `sqlite`.']) expect(readsAsSentence(good), good).toBe(true);
  });

  it('a rewritten line that does not read as a sentence takes the model’s own line, else the base’s, else is left out and the steps are numbered again', () => {
    const proposed = 'Steps:\n1. Use sqlite to read last month’s sales by region.\n2. Write a short summary.';
    const own = wholeSentences('Steps:\n1. read-only SELECT) to read last month’s sales by region.\n2. Write a short summary.', proposed, '');
    expect(own.text).toBe('Steps:\n1. Use sqlite to read last month’s sales by region.\n2. Write a short summary.');
    expect(own.dropped[0]).toMatch(/did not read as a sentence/);
    const fromBase = wholeSentences('Steps:\n1. ) to read the sales by region.\n2. Write a short summary.', 'Steps:', 'Steps:\n1. Read the sales by region.\n2. Write a short summary.');
    expect(fromBase.text).toContain('1. Read the sales by region.');
    const out = wholeSentences('Steps:\n1. ) cut.\n2. Write a short summary.', 'Steps:', '');
    expect(out.text).toBe('Steps:\n1. Write a short summary.');
    expect(out.dropped.join(' ')).toMatch(/left out/);
  });

  it('through the design route: the step of the tool that is gone is gone whole, not cut', async () => {
    const { agent } = await writer([], { instructions: BASE, tools: [{ id: 'tl_1', type: 'node', name: 'sqlite', description: 'Sales', nodeType: 'databases.sqlite', parameters: { operation: 'select', table: 'sales' }, credentials: { sqlite: { id: 'c1', name: 'Sales DB' } } } as never] });
    const body = (await (await withModel({ design: { instructions: BASE, nodeTools: '' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change: 'Remove the sqlite tool, the agent should write from the text.' }))).json()) as Body;
    expect(body.config.instructions).not.toMatch(/SELECT\)|no writes\)/);
    for (const line of (body.config.instructions ?? '').split('\n')) expect(readsAsSentence(line), line).toBe(true);
  });
});

describe('the live change text, with a comma inside brackets (fix pass, item 2)', () => {
  const LIVE = 'Give it the SQLite tool (select / executeQuery, read-only) on the Sales DB credential so it reads the figures';

  it('the tool step the design writes for it is a whole sentence: balanced brackets, no “When asked to Give it”', async () => {
    const { agent } = await writer([]);
    const body = (await (await withModel({ design: { instructions: STEPS, nodeTools: 'databases.sqlite' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change: LIVE }))).json()) as Body;
    const instructions = body.config.instructions ?? '';
    expect(body.config.tools.some((t) => 'nodeType' in t && t.nodeType === 'databases.sqlite')).toBe(true);
    expect(instructions).not.toMatch(/When asked to Give it/i);
    for (const line of instructions.split('\n')) {
      expect(readsAsSentence(line), line).toBe(true);
      expect((line.match(/\(/g) ?? []).length, line).toBe((line.match(/\)/g) ?? []).length);
    }
    expect(instructions).toMatch(/sqlite/i);
  });

  const whenClauses = (instructions: string) => instructions.split('\n').flatMap((l) => (/^\d+\.\s*When /.test(l) ? [l] : []));
  const noGarble = (instructions: string) => {
    expect(instructions).not.toMatch(/When asked to (?:the|a|an|Give|Change|[“"])/);
    for (const line of whenClauses(instructions)) expect(/^\d+\.\s*When ([^,]*(?:\([^)]*\))?[^,]*), call /.exec(line)?.[1] ?? line, line).not.toContain(':');
    for (const line of instructions.split('\n')) expect(readsAsSentence(line), line).toBe(true);
  };

  it('two tools named in one change, with brackets and commas: every step reads, none repeats the ask', async () => {
    const { agent } = await writer([]);
    const change = 'Give it the SQLite tool to read the sales and the Change Case tool (upper, lower) to format the region names';
    const body = (await (await withModel({ design: { instructions: STEPS, nodeTools: 'databases.sqlite' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change }))).json()) as Body;
    expect(body.config.tools.some((t) => 'nodeType' in t && t.nodeType === 'databases.sqlite')).toBe(true);
    noGarble(body.config.instructions ?? '');
    expect(whenClauses(body.config.instructions ?? []).length).toBeGreaterThan(0);
  });

  it('the held retry text as the change (a quoted name, a colon, “Change”) never becomes a step', async () => {
    const { agent } = await writer([]);
    const change = 'The eval gate held “Short writer”. Change “Short writer” so these cases pass without removing what it already does: a case with the input “Read the sqlite sales” scored low: it did not name the regions.';
    const body = (await (await withModel({ design: { instructions: STEPS, nodeTools: 'databases.sqlite' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change }))).json()) as Body;
    noGarble(body.config.instructions ?? '');
  });

  it('a line the proposal itself carried is checked too: wholeSentences judges the proposal, not the text it was rewritten from', () => {
    const garbled = 'Steps:\n1. Write the summary.\n2. When asked to Give it the SQLite tool (select / executeQuery, call sqlite (it asks the person first).';
    const fixed = wholeSentences(garbled, 'Steps:\n1. Write the summary.', '');
    expect(fixed.text).not.toMatch(/When asked to Give it/);
    expect(fixed.dropped.join(' ')).toMatch(/did not read as a sentence/);
    // Before the fix `reviseDraft` passed the rewritten text itself as `proposed`, so this line counted as given and stayed.
    expect(wholeSentences(garbled, garbled, '').text).toContain('When asked to Give it');
  });
});

describe('an agent fix adds only a tool the cause or the person’s ask names (fix pass 2, item 3)', () => {
  type NotAdded = { notAdded: Array<{ name: string; reason: string }> };
  const design = async (change: string, namedBy: string | undefined) => {
    const { agent } = await writer([]);
    return (await (await withModel({ design: { instructions: STEPS, nodeTools: 'databases.sqlite' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change, ...(namedBy !== undefined && { namedBy }) }))).json()) as Body & NotAdded;
  };
  const hasSqlite = (body: Body) => body.config.tools.some((t) => 'nodeType' in t && t.nodeType === 'databases.sqlite');

  it('a tool the design adds that neither the cause, the ask nor (for a read) the change text names is dropped and listed in notAdded, with no step that calls it', async () => {
    const body = await design('Make it read the figures', 'The summary has made-up figures.\nThe numbers look made up. Test it and fix it.');
    expect(hasSqlite(body)).toBe(false);
    expect(body.config.instructions ?? '').not.toMatch(/sqlite/i);
  });

  it('notAdded lists a tool the design added that nothing names', async () => {
    const body = await design('Make it insert the figures into SQLite', 'The summary has made-up figures.\nThe numbers look made up. Test it and fix it.');
    expect(hasSqlite(body)).toBe(false);
    expect(body.notAdded.map((n) => n.reason).join(' ')).toMatch(/neither the failure nor your ask names it/);
  });

  it('the live G case: the change text alone names the SQLite read (no approval, no write): it stays', async () => {
    expect(hasSqlite(await design('Give it the SQLite tool so it reads the figures', 'it has no data, so its figures are made up\nThe numbers look made up. Test it and fix it.'))).toBe(true);
  });

  it('a tool the cause or the ask names is added as before; a design with no namedBy is unchanged', async () => {
    const change = 'Give it the SQLite tool so it reads the figures';
    expect(hasSqlite(await design(change, 'the agent has no database tool'))).toBe(true);
    expect(hasSqlite(await design(change, 'Use the SQLite tool to read the sales.'))).toBe(true);
    const plain = await design(change, undefined);
    expect(hasSqlite(plain)).toBe(true);
  });

  describe('requested (the rule itself)', () => {
    const info = (type: string, displayName: string, keywords: string[] = [], pluginId = type.split('.')[0]) => ({ type, pluginId, pluginName: pluginId, descriptor: { displayName, keywords, properties: [] } }) as never;
    const types = [info('databases.sqlite', 'SQLite', ['sqlite', 'database']), info('text.changeCase', 'Change Case', ['case', 'upper', 'lower'], 'text')];
    const node = (nodeType: string, name: string, extra: Record<string, unknown> = {}) => ({ id: 't', type: 'node', name, description: 'd', nodeType, parameters: {}, ...extra }) as never;
    const { requested, namesTool } = architectApi;
    // What the client sends: the cause and the typed ask; the model's own text is `change`.
    const heldRetry = 'The eval gate held “Short writer”. Change “Short writer” so these cases pass without removing what it already does: a case with the input “Summarise” scored low.';
    const namedBy = 'it has no data, so its figures are made up\nThe numbers look made up. Test it and fix it.';

    it('the live G2 case: a Change Case tool that asks first is dropped, whatever the change text says', () => {
      const changeCase = node('text.changeCase', 'change_case', { requireApproval: true });
      expect(requested(changeCase, { namedBy, change: heldRetry }, types)).toBe(false);
      expect(requested(changeCase, { namedBy, change: 'Change it so the region names are upper case' }, types)).toBe(false);
      expect(requested(node('text.changeCase', 'change_case'), { namedBy, change: heldRetry }, types)).toBe(false); // even a read: “Change” and “cases” are not its name
    });

    it('the live G case: a SQLite select named by the change text alone stays; one that writes or asks first needs the cause or the ask', () => {
      const select = node('databases.sqlite', 'sqlite', { parameters: { operation: 'select' } });
      expect(requested(select, { namedBy, change: 'Give it the SQLite tool so it reads the figures' }, types)).toBe(true);
      const insert = node('databases.sqlite', 'sqlite', { parameters: { operation: 'insert' }, requireApproval: true });
      expect(requested(insert, { namedBy, change: 'Give it the SQLite tool so it saves the figures' }, types)).toBe(false);
      expect(requested(insert, { namedBy: 'it needs a database to save the figures', change: 'x' }, types)).toBe(false); // “database” is common: it names only a read
      expect(requested(insert, { namedBy: 'use the SQLite tool to save the figures', change: 'x' }, types)).toBe(true);
    });

    it('a SQLite tool with no operation runs the default insert: it counts as a write', () => {
      const sq = { type: 'databases.sqlite', pluginId: 'databases', pluginName: 'databases', descriptor: { displayName: 'SQLite', keywords: ['sqlite', 'database'], properties: [{ name: 'operation', type: 'options', default: 'insert', options: [{ name: 'Insert', value: 'insert' }, { name: 'Select', value: 'select', idempotent: true }] }] } } as never;
      const bare = node('databases.sqlite', 'sqlite');
      expect(requested(bare, { namedBy: 'x', change: 'use the database to save' }, [sq])).toBe(false);
      expect(requested(node('databases.sqlite', 'sqlite', { parameters: { operation: 'select' } }), { namedBy: 'x', change: 'use the database' }, [sq])).toBe(true);
    });

    it('an asks-first Attio tool is not named by common words of its app', () => {
      const attio = info('attio.records', 'Create Record', ['attio', 'crm', 'sales', 'message', 'request', 'email'], 'attio');
      const t = node('attio.records', 'attio_create_record', { requireApproval: true });
      const ts = [attio] as never[];
      expect(requested(t, { namedBy: 'Post the sales by region to the receiver', change: 'x' }, ts as never)).toBe(false);
      expect(requested(t, { namedBy: 'Send a message request by email', change: 'x' }, ts as never)).toBe(false);
      expect(requested(t, { namedBy: 'Add the deal in Attio', change: 'x' }, ts as never)).toBe(true);
      expect(namesTool('the sales numbers', t, ts as never)).toBe(true); // loosely, as a read would be named
      expect(namesTool('the sales numbers', t, ts as never, true)).toBe(false);
    });

    it('matches whole words', () => {
      const sqlite = node('databases.sqlite', 'sqlite');
      expect(namesTool('a sqliteish thing and databasesque words', sqlite, types)).toBe(false);
      expect(namesTool('the SQLite tool', sqlite, types)).toBe(true);
      expect(namesTool('change it so these cases pass', node('text.changeCase', 'change_case'), types)).toBe(false);
      expect(namesTool('use the Change Case tool', node('text.changeCase', 'change_case'), types)).toBe(true);
    });
  });
});

describe('cases that make a data agent use its tool (item 4)', () => {
  const FIGURES = 'The North region sold £120k, the South £80k and the West £95k last month. What is the total? => The total is £295k: North £120k, South £80k, West £95k.';

  it('figures stated in the question and repeated in the answer are found, plain years and one digit are not', () => {
    expect([...figuresOf('North £120k, South £80k and 12% in 2026, 3 regions').all].sort()).toEqual(['12%', '£120k', '£80k']);
  });

  it('a change adding SQLite to a writer: the replacement cases that hand over the figures are dropped, the asked-again cases stay', async () => {
    const { agent, cases } = await writer([{ input: 'Summarise: the cat sat on the mat.', expected: 'A one-line summary that uses only the text and never claims to have looked up data.' }]);
    const asked: string[] = [];
    const again = 'How did sales compare by region last month? => Answers with the figures from the sales database, region by region.\nWhich region sold the most last month? => Names the top region from the sales database.';
    const body = (await (await withModel({ asked, again, design: { instructions: STEPS, nodeTools: 'databases.sqlite', contradictedCases: cases[0]!.id, cases: `${FIGURES}\nWhat did North, South and West sell, given North £120k, South £80k, West £95k? => North £120k, South £80k, West £95k.` } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change: 'Connect it to the sales database so it reads the numbers.' }))).json()) as Body;
    expect(body.config.tools.some((t) => 'nodeType' in t && t.nodeType === 'databases.sqlite')).toBe(true);
    expect(body.replaceCases).toEqual([{ id: cases[0]!.id, input: 'Summarise: the cat sat on the mat.' }]);
    expect(body.cases.map((c) => c.input)).toEqual(['How did sales compare by region last month?', 'Which region sold the most last month?']);
    expect(body.cases.every((c) => !/£|\d{2}/.test(c.input + c.expected))).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toContain('states');
    expect(body.changes).toEqual(expect.arrayContaining(['Test removed: “Summarise: the cat sat on the mat.”', 'Test added: “How did sales compare by region last month?”']));
  });

  it('a new case equal to a removed one, case and punctuation folded, is dropped', async () => {
    const { agent, cases } = await writer([{ input: 'Summarise: the cat sat on the mat.', expected: 'A one-line summary that never looks anything up.' }]);
    const again = 'Which region sold the most last month? => Names the top region from the sales database.\nHow many orders came in last month? => Reads the count from the sales database.';
    const body = (await (await withModel({ again, design: { instructions: STEPS, nodeTools: 'databases.sqlite', contradictedCases: cases[0]!.id, cases: 'SUMMARISE:  the cat sat on the mat!! => Reads it from the sales database.\nLook up the data you need => Reads it from the sales database.' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change: 'Connect it to the sales database so it reads the numbers.' }))).json()) as Body;
    expect(body.cases.map((c) => c.input)).not.toContain('SUMMARISE:  the cat sat on the mat!!');
    expect(body.cases.some((c) => /^summarise/i.test(c.input))).toBe(false);
    expect(body.cases.length).toBeGreaterThanOrEqual(2);
  });

  it('a knowledge agent: a case naming a runbook its folder lacks is dropped, one about the document it holds stays', async () => {
    const knowledge = { id: 'tl_k', type: 'knowledge', name: 'runbooks', description: 'Search the runbooks', store: 'sqlite', collection: 'runbooks', embeddings: { provider: 'none', model: 'bm25' } } as never;
    const { agent, cases } = await writer([{ input: 'What is the weather?', expected: 'It does not know.' }], { tools: [knowledge] });
    const again = 'What does the failover runbook say about the primary? => Answers from the failover runbook.\nHow do I fail over? => Quotes the failover steps.';
    const body = (await (await withModel({ again, design: { instructions: STEPS, nodeTools: '', contradictedCases: cases[0]!.id, cases: 'What does the payments runbook say about rollbacks? => Quotes the payments runbook.\nWhat does the failover runbook say about the primary? => Quotes the failover runbook.' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change: 'Answer weather questions by saying the runbooks have no weather.' }))).json()) as Body;
    const inputs = body.cases.map((c) => c.input);
    expect(inputs.some((i) => /payments/i.test(i))).toBe(false);
    expect(inputs).toContain('What does the failover runbook say about the primary?');
  });

  it('checkCases on its own: the answer that gives figures nobody knows is dropped; a data agent’s other cases stay', () => {
    const config = { tools: [{ type: 'node', nodeType: 'databases.sqlite' }] } as unknown as Partial<AgentConfig>;
    const out = checkCases([{ input: 'What was last month’s revenue?', expected: 'Revenue was £1.2M, up 14%.' }, { input: 'What was last month’s revenue?', expected: 'Answers with the revenue from the sales database.' }], { config });
    expect(out.kept).toHaveLength(1);
    expect(out.dropped[0]!.reason).toMatch(/nobody knows/);
  });
});

describe('the design never removes what the session added (keep, item 2)', () => {
  const SQLITE = { id: 'tl_1', type: 'node', name: 'sqlite', description: 'Sales', nodeType: 'databases.sqlite', parameters: { operation: 'select', table: 'sales' }, credentials: { sqlite: { id: 'c1', name: 'Sales DB' } } } as never;
  const CHANGE = 'Remove the sqlite tool, the agent should answer from memory.';

  it('with keep the tool stays, the preview has no “Removes the tool” line and says it kept it', async () => {
    const { agent } = await writer([], { tools: [SQLITE], instructions: 'Input: a request.\nSteps:\n1. Read the sales with sqlite.\nOutput: a summary.' });
    const body = (await (await withModel({ design: { instructions: STEPS, nodeTools: '' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change: CHANGE, keep: { tools: ['sqlite'], reason: 'this session added it' } }))).json()) as Body;
    expect(body.config.tools.map((t) => ('name' in t ? t.name : ''))).toEqual(['sqlite']);
    expect(body.changes.some((c) => /Removes the tool/.test(c))).toBe(false);
    expect(body.dropped).toContain('Kept “sqlite”: this session added it');
    // Fix pass: the kept tool keeps its step too, so the agent still calls it.
    const steps = (body.config.instructions ?? '').split('\n').filter((l) => /^\d+\./.test(l));
    expect(steps.some((l) => /sqlite/i.test(l)), body.config.instructions).toBe(true);
  });

  it('keep names the tool by node type or in another case too', async () => {
    const { agent } = await writer([], { tools: [SQLITE] });
    const body = (await (await withModel({ design: { instructions: STEPS, nodeTools: '' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change: CHANGE, keep: { tools: ['databases.sqlite'], reason: 'added by the session' } }))).json()) as Body;
    expect(body.config.tools).toHaveLength(1);
  });

  it('without keep the change removes it, as on the base', async () => {
    const { agent } = await writer([], { tools: [SQLITE] });
    const body = (await (await withModel({ design: { instructions: STEPS, nodeTools: '' } }, () => post({ name: 'Short writer', preview: true, base: { agentId: agent.id }, change: CHANGE }))).json()) as Body;
    expect(body.config.tools).toHaveLength(0);
    expect(body.changes.some((c) => /Removes the tool/.test(c))).toBe(true);
  });

  it('keep is for a change only: the body takes at most 20 names', async () => {
    const res = await post({ name: 'x', preview: true, base: { config: {} }, change: 'y', keep: { tools: Array.from({ length: 21 }, (_v, i) => `t${i}`), reason: 'r' } });
    expect(res.status).toBe(400);
  });
});

describe('the step built from a tool description (re-review finding 1)', () => {
  const live = 'Read or change data in a a SQLite database file database. Set `operation`: `select` reads rows of `table` (optionally `where`).';
  const tool = (parameters: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ id: 't', type: 'node', name: 'sqlite', description: live, nodeType: 'databases.sqlite', parameters, ...extra }) as never;
  const stepFor = (t: never) => architectApi.withToolSteps('Steps:\n1. Write the summary.', [{ tool: t }], 'Give it the SQLite tool (select / executeQuery, read-only)').split('\n').find((l) => /call sqlite/.test(l)) ?? '';

  it('a pinned select reads: no doubled article, no repeated noun, “read” and “read only”', () => {
    const line = stepFor(tool({ operation: 'select', table: 'sales' }));
    expect(line).not.toMatch(/\ba a\b/);
    expect(line).not.toMatch(/database file database/);
    expect(line).not.toMatch(/read or change/i);
    expect(line).toMatch(/When you need to read data in a SQLite database, call sqlite \(read only\)\./);
  });

  it('a tool whose configured operation writes keeps “read or change”, with the clean noun phrase', () => {
    const line = stepFor(tool({ operation: 'insert', table: 'sales' }, { requireApproval: true }));
    expect(line).toMatch(/read or change data in a SQLite database, call sqlite \(it asks the person first\)/i);
  });
});
