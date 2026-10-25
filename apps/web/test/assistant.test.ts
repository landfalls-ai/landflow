import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { applyOps, describeOps, digestRun, parseOps, structuralWarnings, type AssistantOp } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { recoverToolCalls, runChat, MAX_STEPS, type ChatEvent } from '@/lib/server/assistant/chat';
import { registryLookup, validateOps } from '@/lib/server/assistant/ops';
import { searchNodes } from '@/lib/server/assistant/research';
import { suggestAfterRun } from '@/lib/server/assistant/suggest';

let types: NodeTypeInfo[];
const lookup = () => registryLookup(types);

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

/** Trigger → Code, plus an unconnected If. */
function workflow(): Workflow {
  return {
    id: 'wf_test',
    name: 'Test',
    nodes: [
      { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
      { id: 'b', name: 'Code', type: 'core.code', typeVersion: 1, position: [280, 0], parameters: { mode: 'each', codeEach: 'return $json;' } },
      { id: 'c', name: 'Check', type: 'core.if', typeVersion: 1, position: [560, 0], parameters: {} },
    ],
    connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
  };
}

let counter = 0;
const newId = () => `t${++counter}`;
const apply = (ops: AssistantOp[], wf = workflow()) => applyOps(wf, ops, lookup(), { newId });
const edges = (wf: Workflow) => wf.connections.map((c) => `${c.source}:${c.sourceIndex}-${c.type}->${c.target}:${c.targetIndex}`);

/** A LanguageModel that answers from a script and records what it was asked. */
function scripted(turns: Array<Partial<ModelTurn> | ((input: GenerateInput) => Partial<ModelTurn>)>) {
  const calls: GenerateInput[] = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      calls.push({ ...input, messages: [...input.messages] });
      const next = turns.shift();
      if (!next) throw new Error('No scripted turn left');
      const turn = typeof next === 'function' ? next(input) : next;
      return { text: '', toolCalls: [], stopReason: 'stop', ...turn };
    },
  };
  return { model, calls };
}

describe('assistant ops', () => {
  it('adds a node after another, wired, positioned and with unknown parameters left out', () => {
    const result = apply([{ op: 'addNode', ref: 'dedupe', type: 'core.removeDuplicates', name: 'Dedupe', after: 'Code', parameters: { bogus: 1 } }]);
    expect(result.dropped).toEqual([]);
    expect(result.ignored).toEqual(['“Dedupe” has no parameter “bogus”']);
    const added = result.workflow.nodes.find((n) => n.name === 'Dedupe')!;
    expect(added.id).toBe(result.added[0]);
    expect(added.position[0]).toBe(560);
    // The If already sits at (560, 0): the new node moves down a row.
    expect(added.position[1]).toBe(170);
    expect(edges(result.workflow)).toContain(`b:0-main->${added.id}:0`);
    expect(result.applied).toEqual([{ op: 'addNode', ref: 'dedupe', type: 'core.removeDuplicates', name: 'Dedupe', after: 'Code' }]);
  });

  it('drops what cannot apply, with a reason, and keeps going', () => {
    const result = apply([
      { op: 'addNode', type: 'core.nope', name: 'Ghost' },
      { op: 'connect', from: 'Code', to: 'Start' },
      { op: 'connect', from: 'Check', to: 'Code', output: 5 },
      { op: 'connect', from: 'Check', to: 'Code', output: 1 },
      { op: 'connect', from: 'Start', to: 'Code' },
      { op: 'setParameters', node: 'Nobody', parameters: { a: 1 } },
      { op: 'setParameters', node: 'Code', parameters: { nonsense: true } },
      { op: 'renameNode', node: 'Code', name: 'Check' },
    ]);
    expect(result.dropped).toEqual([
      'add “Ghost”: unknown node type core.nope',
      'connect “Code” → “Start”: “Start” takes no input (it is a trigger)',
      'connect “Check” → “Code”: “Check” has no output 5 (it has 2)',
      'set parameters: no node “Nobody”',
      'set parameters of “Code”: none of nonsense exist',
      'rename “Code”: another node is called “Check”',
    ]);
    expect(result.applied).toEqual([{ op: 'connect', from: 'Check', to: 'Code', output: 1 }]);
  });

  it('attaches sub-nodes to an agent, either direction, replacing a single-model port', () => {
    const result = apply([
      { op: 'addNode', ref: 'agent', type: 'core.aiAgent', name: 'Agent', after: 'Code' },
      { op: 'addNode', ref: 'm1', type: 'core.ollamaChatModel', name: 'Model A', after: 'agent' },
      { op: 'addNode', ref: 'm2', type: 'core.anthropicChatModel', name: 'Model B' },
      { op: 'connect', from: 'agent', to: 'm2' },
      { op: 'addNode', ref: 'calc', type: 'core.calculatorTool', name: 'Calc' },
      { op: 'connect', from: 'calc', to: 'agent', type: 'ai_tool' },
      { op: 'connect', from: 'Code', to: 'agent', type: 'ai_tool' },
    ]);
    const id = (name: string) => result.workflow.nodes.find((n) => n.name === name)!.id;
    expect(result.dropped).toEqual(['connect “Code” → “Agent”: “Code” can’t be attached to “Agent” as ai_tool']);
    const wired = edges(result.workflow);
    // Model B replaced Model A on the one-model port; the edge runs sub-node → agent.
    expect(wired).not.toContain(`${id('Model A')}:0-ai_languageModel->${id('Agent')}:0`);
    expect(wired).toContain(`${id('Model B')}:0-ai_languageModel->${id('Agent')}:0`);
    expect(wired).toContain(`${id('Calc')}:0-ai_tool->${id('Agent')}:0`);
    expect(result.applied.find((op) => op.op === 'connect')).toEqual({ op: 'connect', from: 'm2', to: 'agent', type: 'ai_languageModel' });
    // Sub-nodes sit under the agent.
    const agent = result.workflow.nodes.find((n) => n.name === 'Agent')!;
    expect(result.workflow.nodes.find((n) => n.name === 'Calc')!.position[1]).toBe(agent.position[1] + 200);
  });

  it('fills a Merge’s free inputs in turn', () => {
    const result = apply([
      { op: 'addNode', ref: 'merge', type: 'core.merge', name: 'Merge' },
      { op: 'connect', from: 'Code', to: 'merge' },
      { op: 'connect', from: 'Check', to: 'merge', output: 1 },
    ]);
    const merge = result.added[0];
    expect(edges(result.workflow)).toEqual(expect.arrayContaining([`b:0-main->${merge}:0`, `c:1-main->${merge}:1`]));
  });

  it('inserts a node in front of another, rewiring its input and making room', () => {
    const result = apply([{ op: 'addNode', ref: 'prep', type: 'core.set', name: 'Prepare', before: 'Code' }]);
    const prep = result.added[0];
    expect(result.dropped).toEqual([]);
    expect(edges(result.workflow)).toEqual([`a:0-main->${prep}:0`, `${prep}:0-main->b:0`]);
    const position = (id: string) => result.workflow.nodes.find((n) => n.id === id)!.position;
    // The new node takes Code's place; Code moves right. (Check isn't downstream of Code, so it stays.)
    expect(position(prep)).toEqual([280, 0]);
    expect(position('b')).toEqual([560, 0]);
    expect(position('c')).toEqual([560, 0]);
    expect(describeOps(result.applied, lookup())).toEqual([{ sign: '+', text: '“Prepare” (Edit Fields) before “Code”' }]);
    expect(apply([{ op: 'addNode', type: 'core.manualTrigger', before: 'Code' }]).dropped).toEqual([
      'add “Manual Trigger” before “Code”: only nodes with an input and an output can be inserted',
    ]);
  });

  it('treats a connection that already exists as done, not as a second edge or an error', () => {
    const result = apply([
      { op: 'addNode', ref: 'merge', type: 'core.merge', name: 'Merge', after: 'Code' },
      { op: 'connect', from: 'Code', to: 'merge' },
      { op: 'connect', from: 'Start', to: 'Code' },
    ]);
    expect(result.dropped).toEqual([]);
    expect(result.applied.map((op) => op.op)).toEqual(['addNode']);
    expect(result.workflow.connections).toHaveLength(2);
  });

  it('sets parameters like the editor, renames with references and removes nodes with their edges', () => {
    const wf = workflow();
    wf.nodes.push({ id: 'd', name: 'Use', type: 'core.set', typeVersion: 1, position: [840, 0], parameters: { mode: 'json', json: '{"x": "{{ $(\'Code\').item.json.x }}", "y": "{{ $node["Code"].json.y }}"}' } });
    const result = apply(
      [
        { op: 'setParameters', node: 'code', parameters: { mode: 'all', code: 'return items;' } },
        { op: 'renameNode', node: 'Code', name: 'Transform' },
        { op: 'removeNode', node: 'Check' },
      ],
      wf,
    );
    expect(result.dropped).toEqual([]);
    const code = result.workflow.nodes.find((n) => n.id === 'b')!;
    expect(code.name).toBe('Transform');
    expect(code.parameters).toMatchObject({ mode: 'all', code: 'return items;' });
    expect(result.workflow.nodes.find((n) => n.id === 'd')!.parameters.json).toBe('{"x": "{{ $(\'Transform\').item.json.x }}", "y": "{{ $node["Transform"].json.y }}"}');
    expect(result.workflow.nodes.map((n) => n.id)).toEqual(['a', 'b', 'd']);
    expect(result.applied[0]).toEqual({ op: 'setParameters', node: 'Code', parameters: { mode: 'all', code: 'return items;' } });
  });

  it('parses loose model output and describes ops as a diff', () => {
    const { ops, dropped } = parseOps([
      { op: 'addNode', nodeType: 'core.limit', name: 'Top 3', after: 'Code', output: '0', parameters: { maxItems: 3 } },
      { action: 'connect', source: 'Top 3', target: 'Check', type: 'weird' },
      { op: 'explode' },
      'nope',
    ]);
    expect(ops).toEqual([
      { op: 'addNode', type: 'core.limit', name: 'Top 3', after: 'Code', output: 0, parameters: { maxItems: 3 } },
      { op: 'connect', from: 'Top 3', to: 'Check' },
    ]);
    expect(dropped).toHaveLength(2);
    const { applied } = apply(ops);
    expect(describeOps([...applied, { op: 'removeNode', node: 'Check' }, { op: 'renameNode', node: 'Code', name: 'Clean' }], lookup())).toEqual([
      { sign: '+', text: '“Top 3” (Limit) after “Code” · maxItems = 3' },
      { sign: '→', text: '“Top 3” → “Check”' },
      { sign: '−', text: '“Check”' },
      { sign: '✎', text: '“Code” → “Clean”' },
    ]);
  });

  it('validates against the registry and digests runs', () => {
    const validated = validateOps(workflow(), [{ op: 'addNode', type: 'core.sort', after: 'Code' }, { op: 'removeNode' }], lookup());
    expect(validated.ops).toEqual([{ op: 'addNode', ref: 'Sort', type: 'core.sort', name: 'Sort', after: 'Code' }]);
    expect(validated.dropped).toHaveLength(1);
    const digest = digestRun({
      startedAt: '',
      durationMs: 5,
      status: 'success',
      source: 'main',
      inputs: [[{ json: { text: 'x'.repeat(500) } }]],
      outputs: [Array.from({ length: 10 }, (_, i) => ({ json: { i } }))],
    });
    expect(digest.outputs[0]).toEqual({ count: 10, sample: [{ i: 0 }, { i: 1 }, { i: 2 }] });
    expect(String((digest.inputs[0].sample[0] as { text: string }).text)).toMatch(/… \(500 chars\)$/);
  });

  it('warns about what a change leaves dangling', () => {
    const before = workflow();
    const { workflow: after } = apply(
      [
        { op: 'disconnect', from: 'Start', to: 'Code' },
        { op: 'addNode', type: 'core.sort', name: 'Loose' },
        { op: 'addNode', type: 'core.aiAgent', name: 'Agent', after: 'Check' },
        { op: 'addNode', type: 'core.simpleMemory', name: 'Memory' },
        { op: 'addNode', ref: 'pre', type: 'core.set', name: 'Prepare', after: 'Start' },
        { op: 'connect', from: 'pre', to: 'Check' },
        { op: 'connect', from: 'Start', to: 'Check' },
      ],
      before,
    );
    expect(structuralWarnings(before, after, lookup())).toEqual([
      '“Code” no longer receives any input',
      '“Check” now gets input from both “Prepare” and “Start”',
      'new node “Loose” has no input',
      'new node “Agent” needs a Chat Model attached',
      'new node “Memory” isn’t attached to anything',
    ]);
  });

  it('finds nodes by keyword', () => {
    expect(searchNodes('dedupe duplicates', types)[0].type).toBe('core.removeDuplicates');
    expect(searchNodes('a', types)).toEqual([]);
  });
});

const failedRun = {
  status: 'error',
  durationMs: 3,
  error: { message: 'Cannot read properties of undefined (reading "toUpperCase")', description: 'line 1' },
  inputs: [{ count: 2, sample: [{ title: 'Hi' }, { title: 'There' }] }],
  outputs: [],
};

describe('after-run suggestions', () => {
  it('parses, validates and ranks the model’s suggestions', async () => {
    const reply = JSON.stringify({
      suggestions: [
        { kind: 'next', title: 'Sort by title', detail: 'Then sort.', confidence: 0.4, ops: [{ op: 'addNode', type: 'core.sort', name: 'Sort', after: 'Code' }] },
        { kind: 'FIX', title: 'Read “title”, not “name”', detail: 'Items have no name field.', confidence: 90, ops: [{ op: 'setParameters', node: 'Code', parameters: { codeEach: 'return { ...$json, upper: $json.title.toUpperCase() };' } }] },
        { kind: 'data', title: 'Log the bad items', detail: 'x', confidence: 0.3, ops: [{ op: 'addNode', type: 'google.sheets', after: 'Code' }] },
        { kind: 'param', title: 'Looks fine', detail: 'Nothing to change.', confidence: 0.95, ops: [] },
        { kind: 'param', title: 'Same fix again', detail: 'x', confidence: 0.8, ops: [{ op: 'setParameters', node: 'Code', parameters: { codeEach: 'return { ...$json, upper: $json.title.toUpperCase() };' } }] },
        { title: '' },
      ],
    });
    const { model, calls } = scripted([{ text: `Sure!\n\`\`\`json\n${reply}\n\`\`\`` }]);
    const result = await suggestAfterRun({ workflow: workflow(), nodeId: 'b', run: failedRun, model, types });

    expect(result.model).toBe('test/scripted');
    expect(result.suggestions.map((s) => [s.kind, s.title, s.confidence, s.ops.length])).toEqual([
      ['fix', 'Read “title”, not “name”', 0.9, 1],
      ['next', 'Sort by title', 0.4, 1],
      ['data', 'Log the bad items', 0.3, 0],
    ]);
    expect(result.suggestions[2].dropped).toEqual(['add “google.sheets”: unknown node type google.sheets']);
    // One JSON call that saw the error, the input sample and the node's docs.
    expect(calls).toHaveLength(1);
    expect(calls[0].responseFormat).toBe('json');
    const prompt = (calls[0].messages[0] as { content: string }).content;
    expect(prompt).toContain('Cannot read properties of undefined');
    expect(prompt).toContain('{"title":"Hi"}');
    expect(prompt).toContain('codeEach (');
  });

  it('skips a manual trigger without asking the model', async () => {
    const { model, calls } = scripted([]);
    const result = await suggestAfterRun({
      workflow: workflow(),
      nodeId: 'a',
      run: { status: 'success', durationMs: 0, inputs: [], outputs: [{ count: 1, sample: [{}] }] },
      model,
      types,
    });
    expect(result.suggestions).toEqual([]);
    expect(result.skipped).toMatch(/manualTrigger/);
    expect(calls).toHaveLength(0);
  });

  it('fails when the reply is not JSON', async () => {
    const { model } = scripted([{ text: 'I think it is fine.' }]);
    await expect(suggestAfterRun({ workflow: workflow(), nodeId: 'b', run: failedRun, model, types })).rejects.toThrow(/not valid JSON/);
  });
});

describe('builder chat', () => {
  it('researches with tools, then proposes validated changes', async () => {
    const { model, calls } = scripted([
      {
        text: 'Let me look.',
        toolCalls: [
          { id: 'c1', name: 'search_nodes', input: { query: 'remove duplicates' } },
          { id: 'c2', name: 'get_node_docs', input: { type: 'core.removeDuplicates' } },
        ],
      },
      {
        toolCalls: [
          {
            id: 'c3',
            name: 'propose_changes',
            // Some models send nested arrays as a JSON string.
            input: { summary: 'Dedupe after Code', ops: JSON.stringify([{ op: 'addNode', ref: 'd', type: 'core.removeDuplicates', name: 'Dedupe', after: 'Code' }, { op: 'connect', from: 'd', to: 'Nowhere' }]) },
          },
        ],
      },
      { toolCalls: [{ id: 'c4', name: 'propose_changes', input: { summary: 'Broken', ops: [{ op: 'removeNode', node: 'Ghost' }] } }] },
      { text: 'Added a Remove Duplicates node after Code. Run it to check.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Remove duplicate items after Code' }], workflow: workflow(), selectedNodeId: 'b', model, types, onEvent: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'tool', 'tool', 'proposal', 'tool', 'text', 'done']);
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools.map((e) => [e.label, e.ok])).toEqual([
      ['Searched nodes for “remove duplicates”', true],
      ['Read Remove Duplicates docs', true],
      ['Proposed 1 change', true],
      ['Proposal rejected: remove: no node “Ghost”', false],
    ]);
    const proposal = events.find((e) => e.type === 'proposal')!;
    expect(proposal).toMatchObject({
      summary: 'Dedupe after Code',
      ops: [{ op: 'addNode', ref: 'd', type: 'core.removeDuplicates', name: 'Dedupe', after: 'Code' }],
      dropped: ['connect “d” → “Nowhere”: no node “Nowhere”'],
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', model: 'test/scripted', steps: 4 });

    // The system prompt carries the workflow and the selected node; tool results go back to the model.
    expect(calls[0].system).toContain('The user has “Code” selected');
    expect(calls[0].tools.map((t) => t.name)).toEqual(['search_nodes', 'get_node_docs', 'get_workflow', 'get_run_data', 'propose_changes']);
    const results = calls[1].messages.at(-1) as { role: 'tool'; results: Array<{ name: string; content: string }> };
    expect(results.results[0].content).toContain('core.removeDuplicates');
    expect(results.results[1].content).toContain('Parameters:');
    const rejected = calls[3].messages.at(-1) as { role: 'tool'; results: Array<{ isError?: boolean }> };
    expect(rejected.results[0].isError).toBe(true);
  });

  it('sends an incomplete change back once, then shows it with its warnings', async () => {
    const dangling = { summary: 'Unhook Code', ops: [{ op: 'disconnect', from: 'Start', to: 'Code' }] };
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: dangling }] },
      { toolCalls: [{ id: 'c2', name: 'propose_changes', input: dangling }] },
      { text: 'Done.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Disconnect Code' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools.map((e) => e.ok)).toEqual([false, true]);
    expect((calls[1].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content).toContain('“Code” no longer receives any input');
    expect(events.find((e) => e.type === 'proposal')).toMatchObject({ warnings: ['“Code” no longer receives any input'] });
  });

  it('reads back a tool call the model wrote as text', async () => {
    const written = [
      'I’ll empty it.',
      '<function=propose_changes>',
      '<parameter=summary>',
      'Empty Code',
      '</parameter>',
      '<parameter=ops>',
      '[{"op":"setParameters","node":"Code","parameters":{"codeEach":"return {};"}}]',
      '</parameter>',
      '</function>',
      '</tool_call>',
    ].join('\n');
    const { model } = scripted([{ text: written }, { text: written }, { text: 'Done.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Empty Code' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    expect(events[0]).toEqual({ type: 'text', text: 'I’ll empty it.' });
    expect(events.find((e) => e.type === 'proposal')).toMatchObject({ summary: 'Empty Code', ops: [{ op: 'setParameters', node: 'Code', parameters: { codeEach: 'return {};' } }] });
    // The same proposal again is skipped, not shown twice.
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'tool').map((e) => e.label)).toEqual(['Proposed 1 change', 'Skipped a repeated proposal']);
    expect(recoverToolCalls('<function=rm_rf><parameter=x>1</parameter></function>').calls).toEqual([]);
  });

  it('stops after the step limit', async () => {
    const { model, calls } = scripted(Array.from({ length: MAX_STEPS + 2 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'get_workflow', input: {} }] })));
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Loop forever' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    expect(calls).toHaveLength(MAX_STEPS);
    expect(events.at(-2)).toMatchObject({ type: 'text', text: expect.stringContaining(`Stopped after ${MAX_STEPS} steps`) });
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: MAX_STEPS });
  });
});
