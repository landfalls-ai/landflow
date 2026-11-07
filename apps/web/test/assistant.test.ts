import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import { applyOps, describeOps, digestRun, parseOps, structuralWarnings, type AssistantOp } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { opsArgument, withEarlierRefs, recoverToolCalls, runChat, withoutApplyRequests, withoutAppliedClaims, withoutEchoedNotes, withoutInventedIds, withoutMadeUpIds, withoutRepeats, withTeamIds, unitSlips, MAX_STEPS, type ChatEvent } from '@/lib/server/assistant/chat';
import { registryLookup, unknownReferenceCautions, validateOps } from '@/lib/server/assistant/ops';
import { nodeDocs, outputFields, searchNodes } from '@/lib/server/assistant/research';
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

  it('finds a duration the request named set in the wrong unit, and sends the proposal back once', async () => {
    const props = () => types.find((t) => t.type === 'core.a2aAgent')!.descriptor.properties;
    const set = (timeout: number) => [{ op: 'setParameters', node: 'Developer', parameters: { options: { timeout } } }];
    expect(unitSlips(set(1800), "set the developer node's timeout to 30 minutes.", props)).toEqual(['“Timeout (ms)” is in milliseconds: 30 minutes is 1800000, not 1800']);
    expect(unitSlips(set(30), 'a 30 min timeout', props)).toEqual(['“Timeout (ms)” is in milliseconds: 30 min is 1800000, not 30']);
    expect(unitSlips(set(1_800_000), 'a 30 minute timeout', props)).toEqual([]);
    expect(unitSlips(set(45_000), 'a 30 minute timeout', props)).toEqual([]);
    expect(unitSlips(set(1800), 'make it faster', props)).toEqual([]);

    const flow = workflow();
    flow.nodes.push({ id: 'dv', name: 'Developer', type: 'core.a2aAgent', typeVersion: 1, position: [0, 0], parameters: { agentUrl: 'http://agent' } });
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Timeout', ops: set(1800) } }] },
      { toolCalls: [{ id: 'c2', name: 'propose_changes', input: { summary: 'Timeout', ops: set(1_800_000) } }] },
      { text: 'Done.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: "Set the Developer node's timeout to 30 minutes." }], workflow: flow, model, types, onEvent: (e) => events.push(e) });
    expect((calls[1].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content).toContain('30 minutes is 1800000, not 1800');
    expect(events.filter((e) => e.type === 'proposal')).toEqual([expect.objectContaining({ ops: [{ op: 'setParameters', node: 'Developer', parameters: { options: { timeout: 1_800_000 } } }] })]);
  });

  it('docs give a collection field’s label, where its unit is, and its range', () => {
    const docs = nodeDocs(types.find((t) => t.type === 'core.a2aAgent')!);
    expect(docs).toContain('timeout (number, “Timeout (ms)”, 1000–3600000)');
  });

  it('docs name the fields a node writes, from its output schema', () => {
    const d = { ...types.find((t) => t.type === 'core.a2aAgent')!.descriptor, outputSchema: { type: 'object', properties: { url: { type: 'string' }, snapshot: { type: 'string', description: 'the page as text' }, stepsRun: { type: 'number' } } } };
    expect(outputFields(d)).toBe('url (string); snapshot (string) — the page as text; stepsRun (number)');
    const info = { ...types.find((t) => t.type === 'core.a2aAgent')!, descriptor: d };
    expect(nodeDocs(info)).toContain('Each output item has: url (string); snapshot (string) — the page as text; stepsRun (number).');
    expect(outputFields({ ...d, outputSchema: undefined })).toBe('');
    expect(nodeDocs(types.find((t) => t.type === 'core.a2aAgent')!)).not.toContain('Each output item has');
  });

  it('attaches a node added after an agent and connected to it as a tool as that only, not also as a step after it', () => {
    const result = apply([
      { op: 'addNode', ref: 'ag', type: 'core.aiAgent', name: 'Agent', after: 'Code' },
      { op: 'addNode', ref: 'tool', type: 'core.httpRequest', name: 'Fetch', after: 'ag' },
      { op: 'connect', from: 'tool', to: 'ag', type: 'ai_tool' },
    ]);
    const id = (name: string) => result.workflow.nodes.find((n) => n.name === name)!.id;
    const between = result.workflow.connections.filter((c) => [c.source, c.target].includes(id('Fetch'))).map((c) => `${c.type}:${c.source === id('Fetch') ? 'Fetch' : 'Agent'}`);
    expect(between).toEqual(['ai_tool:Fetch']);
    expect(result.applied.find((op) => op.op === 'addNode' && op.name === 'Fetch')).not.toHaveProperty('after');
  });

  it('disconnects the edge the way it was asked: the main edge after an agent, not also the tool edge into it', () => {
    const wired = apply([
      { op: 'addNode', ref: 'ag', type: 'core.aiAgent', name: 'Agent', after: 'Code' },
      { op: 'addNode', ref: 'tool', type: 'core.httpRequest', name: 'Fetch' },
      { op: 'connect', from: 'Agent', to: 'Fetch' },
      { op: 'connect', from: 'Fetch', to: 'Agent', type: 'ai_tool' },
    ]).workflow;
    const id = (wf: Workflow, name: string) => wf.nodes.find((n) => n.name === name)!.id;
    const kinds = (wf: Workflow) => wf.connections.filter((c) => [c.source, c.target].includes(id(wf, 'Fetch'))).map((c) => `${c.type}:${c.source === id(wf, 'Fetch') ? 'Fetch→Agent' : 'Agent→Fetch'}`);
    expect(kinds(wired).sort()).toEqual(['ai_tool:Fetch→Agent', 'main:Agent→Fetch']);
    const main = apply([{ op: 'disconnect', from: 'Agent', to: 'Fetch' }], wired).workflow;
    expect(kinds(main)).toEqual(['ai_tool:Fetch→Agent']);
    // Asked the other way round, a sub-node edge still goes.
    const tool = apply([{ op: 'disconnect', from: 'Agent', to: 'Fetch', type: 'ai_tool' }], main).workflow;
    expect(kinds(tool)).toEqual([]);
  });

  it('doesn’t warn that a node attached to an agent as a tool has no input', () => {
    const before = apply([
      { op: 'addNode', ref: 'ag', type: 'core.aiAgent', name: 'Agent', after: 'Code' },
      { op: 'addNode', ref: 'tool', type: 'core.httpRequest', name: 'Fetch' },
      { op: 'connect', from: 'Agent', to: 'Fetch' },
      { op: 'connect', from: 'Fetch', to: 'Agent', type: 'ai_tool' },
    ]).workflow;
    const after = apply([{ op: 'disconnect', from: 'Agent', to: 'Fetch' }], before).workflow;
    expect(structuralWarnings(before, after, lookup()).filter((w) => w.includes('Fetch'))).toEqual([]);
  });

  it('turns a bare $fromAI into the expression the agent fills, with the parameter’s name and display name', () => {
    const added = validateOps(workflow(), [{ op: 'addNode', ref: 'd', type: 'core.a2aAgent', name: 'Developer', after: 'Code', parameters: { agentUrl: '$fromAI' } }], lookup());
    expect(added.workflow.nodes.find((n) => n.name === 'Developer')!.parameters.agentUrl).toBe("{{ $fromAI('agentUrl', 'Agent URL', 'string') }}");
    // The call without its braces gets them; an expression already written is kept.
    const call = validateOps(added.workflow, [{ op: 'setParameters', node: 'Developer', parameters: { agentUrl: "$fromAI('url', 'Where the agent is', 'string')" } }], lookup());
    expect(call.workflow.nodes.find((n) => n.name === 'Developer')!.parameters.agentUrl).toBe("{{ $fromAI('url', 'Where the agent is', 'string') }}");
    const kept = validateOps(call.workflow, [{ op: 'setParameters', node: 'Developer', parameters: { agentUrl: "{{ $fromAI('u', 'U', 'string') }}" } }], lookup());
    expect(kept.workflow.nodes.find((n) => n.name === 'Developer')!.parameters.agentUrl).toBe("{{ $fromAI('u', 'U', 'string') }}");
  });

  it('leaves out numbers outside a field’s range, top level or in a collection, with a reason', () => {
    // "A 30 minute timeout" on a field in milliseconds (1,000 to 3,600,000) came back as 30.
    const added = validateOps(workflow(), [{ op: 'addNode', ref: 'd', type: 'core.a2aAgent', name: 'Developer', after: 'Code', parameters: { agentUrl: 'http://agent', options: { timeout: 30 } } }], lookup());
    expect(added.dropped).toEqual(['“Timeout (ms)” of “Developer”: 30 is under its minimum of 1000']);
    expect(added.ops[0]).toMatchObject({ op: 'addNode', parameters: { agentUrl: 'http://agent' } });
    expect(added.workflow.nodes.find((n) => n.name === 'Developer')!.parameters.options).toEqual({});
    const fixed = validateOps(added.workflow, [{ op: 'setParameters', node: 'Developer', parameters: { options: { timeout: 1_800_000 } } }], lookup());
    expect(fixed.dropped).toEqual([]);
    expect(fixed.workflow.nodes.find((n) => n.name === 'Developer')!.parameters.options).toEqual({ timeout: 1_800_000 });
    const over = validateOps(fixed.workflow, [{ op: 'setParameters', node: 'Developer', parameters: { options: { timeout: 7_200_000 } } }], lookup());
    expect(over.dropped).toEqual(['“Timeout (ms)” of “Developer”: 7200000 is over its maximum of 3600000']);
    expect(over.ops).toEqual([]);
    expect(over.workflow.nodes.find((n) => n.name === 'Developer')!.parameters.options).toEqual({ timeout: 1_800_000 });
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
    const dedupe = { summary: 'Dedupe after Code', ops: JSON.stringify([{ op: 'addNode', ref: 'd', type: 'core.removeDuplicates', name: 'Dedupe', after: 'Code' }, { op: 'connect', from: 'd', to: 'Nowhere' }]) };
    const { model, calls } = scripted([
      {
        text: 'Let me look.',
        toolCalls: [
          { id: 'c1', name: 'search_nodes', input: { query: 'remove duplicates' } },
          { id: 'c2', name: 'get_node_docs', input: { type: 'core.removeDuplicates' } },
        ],
      },
      // Some models send nested arrays as a JSON string. A part that fails sends it back once; sent again, it is shown.
      { toolCalls: [{ id: 'c3', name: 'propose_changes', input: dedupe }] },
      { toolCalls: [{ id: 'c3b', name: 'propose_changes', input: dedupe }] },
      { toolCalls: [{ id: 'c4', name: 'propose_changes', input: { summary: 'Broken', ops: [{ op: 'removeNode', node: 'Ghost' }] } }] },
      { text: 'Added a Remove Duplicates node after Code. Run it to check.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Remove duplicate items after Code' }], workflow: workflow(), selectedNodeId: 'b', model, types, onEvent: (e) => events.push(e) });

    expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'tool', 'tool', 'tool', 'proposal', 'tool', 'text', 'done']);
    const tools = events.filter((e) => e.type === 'tool');
    expect(tools.map((e) => [e.label, e.ok])).toEqual([
      ['Searched nodes for “remove duplicates”', true],
      ['Read Remove Duplicates docs', true],
      ['Proposal incomplete: connect “d” → “Nowhere”: no node “Nowhere”', false],
      ['Proposed 1 change', true],
      ['Proposal rejected: remove: no node “Ghost”', false],
    ]);
    const proposal = events.find((e) => e.type === 'proposal')!;
    expect(proposal).toMatchObject({
      summary: 'Dedupe after Code',
      ops: [{ op: 'addNode', ref: 'd', type: 'core.removeDuplicates', name: 'Dedupe', after: 'Code' }],
      dropped: ['connect “d” → “Nowhere”: no node “Nowhere”'],
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', model: 'test/scripted', steps: 5 });
    // "Added a Remove Duplicates node" is not true until the user clicks Apply, so that sentence is left out.
    expect(events.at(-2)).toEqual({ type: 'text', text: 'Run it to check.' });

    // The system prompt carries the workflow and the selected node; tool results go back to the model.
    expect(calls[0].system).toContain('The user has “Code” selected');
    expect(calls[0].tools.map((t) => t.name)).toEqual(['search_nodes', 'get_node_docs', 'get_workflow', 'get_run_data', 'propose_changes']);
    const results = calls[1].messages.at(-1) as { role: 'tool'; results: Array<{ name: string; content: string }> };
    expect(results.results[0].content).toContain('core.removeDuplicates');
    expect(results.results[1].content).toContain('Parameters:');
    const sentBack = calls[2].messages.at(-1) as { role: 'tool'; results: Array<{ content: string; isError?: boolean }> };
    expect(sentBack.results[0]).toMatchObject({ isError: true, content: expect.stringContaining('Not shown yet: part of this change failed: connect “d” → “Nowhere”') });
    const rejected = calls[4].messages.at(-1) as { role: 'tool'; results: Array<{ isError?: boolean }> };
    expect(rejected.results[0].isError).toBe(true);
  });

  it('tells the model which plugins it may use and what the user tagged', async () => {
    const { model, calls } = scripted([{ text: 'Code runs JavaScript on each item.' }]);
    const allowed = types.filter((t) => t.type !== 'core.removeDuplicates');
    await runChat({
      messages: [{ role: 'user', content: 'What does @Code do, and should I use Remove Duplicates?' }],
      workflow: workflow(),
      model,
      types: allowed,
      // A tagged type the workflow may not use, and a node that isn't there, are left out.
      mentions: { nodes: ['b', 'ghost'], types: ['core.if', 'core.removeDuplicates'] },
      onEvent: () => {},
    });
    const system = calls[0].system ?? '';
    expect(system).toMatch(/Apps and plugins this workflow can use[^\n]*\n- Built in: /);
    expect(system).toContain('The user tagged in the message:\n- the node “Code” (core.code)\n- the node type If (core.if)');
    expect(system).not.toContain('the node type Remove Duplicates');
  });

  it('never says a proposed change was made, and leaves answers without a proposal alone', () => {
    expect(withoutAppliedClaims('The Slack node has been added after Filter. Pick a Slack credential before running it.')).toBe('Pick a Slack credential before running it.');
    expect(withoutAppliedClaims("I've updated the filter so it keeps paid orders.")).toBe('Review the change on the card, then click Apply to make it.');
    expect(withoutAppliedClaims('Connected Webhook to Format reply.\nIt is now connected to Slack too.')).toBe('Review the change on the card, then click Apply to make it.');
    expect(withoutAppliedClaims('The workflow is ready to post replies to Slack. Then run the workflow to test it.')).toBe('Then run the workflow to test it.');
    expect(withoutAppliedClaims('The workflow now has a Slack node after Reply. You still need to:\n1. Click Apply.')).toBe('You still need to:\n1. Click Apply.');
    // Lists keep their lines; "Set up …" is an instruction.
    const steps = 'You need to:\n1. Click Apply on the card.\n2. Set up a Slack credential.\n3. Run the workflow.';
    expect(withoutAppliedClaims(steps)).toBe(steps);
    expect(withoutAppliedClaims('Done.\n\n1. Added a Slack node after Reply.\n2. Pick a channel in it.')).toBe('Done.\n\n2. Pick a channel in it.');
    expect(withoutAppliedClaims('This adds a Slack message after Filter; click Apply, then pick a credential.')).toBe('This adds a Slack message after Filter; click Apply, then pick a credential.');
    // "Will now" and "now posts" describe the change as made too.
    expect(withoutAppliedClaims('The workflow will now post the answer to Slack after Reply. You need to:\n1. Click Apply.')).toBe('You need to:\n1. Click Apply.');
    expect(withoutAppliedClaims('It now posts to Slack. Pick a channel.')).toBe('Pick a channel.');
    expect(withoutAppliedClaims('The error was fixed by replacing the code. The Join Titles node now uses one list.\nRun it.')).toBe('Run it.');
  });

  it('drops copied history notes, exact repeats and, in a test session, requests to apply or run', () => {
    expect(withoutEchoedNotes('Let me fix it.\n[Proposed “Replace Create Message”: applied]\nDone.')).toBe('Let me fix it.\nDone.');
    expect(withoutRepeats('The workflow is not yet producing the output. Adding a node.', 'The workflow is not yet producing the output.')).toBe('Adding a node.');
    expect(withoutApplyRequests('Switched the mode to all. To complete the fix, please click the Apply button. Then run the workflow again.')).toBe('Switched the mode to all.');
    expect(withoutApplyRequests('I changed the mode to all.\n\nPlease apply the proposed change to fix the workflow.')).toBe('I changed the mode to all.');
    expect(withoutApplyRequests('The output matches your request.\n\n{"error": "No change needed"}\n\nNo changes are needed.')).toBe('The output matches your request.\n\nNo changes are needed.');
  });

  it('never repeats a made-up id in its text, and keeps ids the user gave', () => {
    // An id left out of a proposal, in brackets or not, and an id-like token nobody mentioned.
    expect(withoutMadeUpIds('2. Fill in the Slack channel ID (C057L43652P) in the new Slack Message node', '', ['C057L43652P'])).toBe('2. Fill in the Slack channel ID in the new Slack Message node');
    expect(withoutMadeUpIds('Post to C057N3842P9, then check it.', 'the workflow')).toBe('Post to the right id, then check it.');
    expect(withoutMadeUpIds('Post to “C0ABCDEF12” as asked.', 'user: use channel C0ABCDEF12')).toBe('Post to “C0ABCDEF12” as asked.');
    // Short words and plain capitals are not ids.
    expect(withoutMadeUpIds('Use SHA256 or HTTPS, as in ISO8601.', '')).toBe('Use SHA256 or HTTPS, as in ISO8601.');
  });

  it('leaves out what a reply says twice around a tool call', async () => {
    const first = 'The Hash node is a tool for the agent that hashes text using the SHA-256 algorithm. It is connected to the Agent as one of its tools, so when the agent needs to hash something, it can use this tool.';
    const again = 'The Hash node hashes text for the agent using the SHA-256 algorithm. It is connected to the Agent as a tool, so when the agent needs to hash something, it can use this tool. It has no input connections of its own: the agent invokes it.';
    expect(withoutRepeats(again, first)).toBe('It has no input connections of its own: the agent invokes it.');
    expect(withoutRepeats('Short again.', 'Short again.')).toBe('Short again.');
    const { model } = scripted([{ text: first, toolCalls: [{ id: 'c1', name: 'get_workflow', input: {} }] }, { text: again }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'What does Hash do?' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toEqual([first, 'It has no input connections of its own: the agent invokes it.']);
  });

  it('leaves out ids nobody gave, and keeps ones the user or the workflow did', async () => {
    const save = (name: string, dataTableId: string) => ({ summary: 'Save rows', ops: [{ op: 'addNode', type: 'core.dataTable', name, after: 'Code', parameters: { operation: 'insert', dataTableId } }] });
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: save('Save', 'dt_k3J9xQ2mPz') }] },
      { toolCalls: [{ id: 'c2', name: 'propose_changes', input: save('Save given', 'dt_given42') }] },
      { text: 'Pick the table on the card (dt_k3J9xQ2mPz); dt_given42 is set.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Save the items, to table dt_given42 if it helps' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    const [made, given] = events.filter((e) => e.type === 'proposal') as Array<Extract<ChatEvent, { type: 'proposal' }>>;
    expect(made.dropped).toContain('dataTableId of “Save”: an id nobody gave, left for the user to fill in');
    expect(made.ops[0]).toMatchObject({ op: 'addNode', parameters: { operation: 'insert' } });
    expect((made.ops[0] as { parameters: object }).parameters).not.toHaveProperty('dataTableId');
    expect(given.ops[0]).toMatchObject({ parameters: { operation: 'insert', dataTableId: 'dt_given42' } });
    expect(given.dropped.join()).not.toContain('nobody gave');
    expect((calls[1].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content).toContain('dataTableId of “Save”: an id nobody gave');
    // Nor does the text repeat the made-up one.
    expect(events.at(-2)).toEqual({ type: 'text', text: 'Pick the table on the card; dt_given42 is set.' });
    // Expressions, other parameters and a value the node type itself offers are left alone.
    const offered = () => JSON.stringify([{ name: 'modelId', default: 'gpt-5-mini' }]);
    expect(withoutInventedIds([{ op: 'setParameters', node: 'A', parameters: { sheetId: '{{ $json.sheet }}', name: 'X9Y8Z7W6V5', modelId: 'gpt-5-mini' } }], '', offered).invented).toEqual([]);
  });

  it('turns a team written by name or by its lead into the team’s id', () => {
    const teams = [
      { id: 'team_tl1', name: 'Tech Lead team', version: 2, members: [{ title: 'Tech Lead' }, { title: 'Reviewer', reportsTo: 'Tech Lead' }] },
      { id: 'team_ops', name: 'Ops', version: 1, members: [{ title: 'On-call' }] },
    ];
    const add = (teamId: string) => [{ op: 'addNode', type: 'core.runTeam', name: 'Run Team', parameters: { teamId, teamName: '', message: 'Review' } }];
    const params = (ops: unknown) => (ops as Array<{ parameters: Record<string, unknown> }>)[0].parameters;
    // The lead's title, the team's name with or without "team", and the id itself.
    for (const written of ['Tech Lead', 'tech lead team', 'team_tl1']) expect(params(withTeamIds(add(written), teams))).toMatchObject({ teamId: 'team_tl1', teamName: 'Tech Lead team', message: 'Review' });
    expect(params(withTeamIds(add('ops'), teams))).toMatchObject({ teamId: 'team_ops', teamName: 'Ops' });
    // A name no team has, and an expression, are left as written.
    expect(params(withTeamIds(add('Marketing'), teams))).toMatchObject({ teamId: 'Marketing', teamName: '' });
    expect(params(withTeamIds(add('{{ $json.team }}'), teams))).toMatchObject({ teamId: '{{ $json.team }}' });
    // setParameters on a Run a Team node already in the flow; other nodes' teamId is not touched.
    const set = [{ op: 'setParameters', node: 'Run Team', parameters: { teamId: 'Ops' } }];
    expect(params(withTeamIds(set, teams, (name) => (name === 'Run Team' ? 'core.runTeam' : undefined)))).toEqual({ teamId: 'team_ops', teamName: 'Ops' });
    expect(params(withTeamIds(set, teams))).toEqual({ teamId: 'Ops' });
  });

  it('doesn’t add back a node a pending proposal removes, and says to stop once all is proposed', async () => {
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Remove Check', ops: [{ op: 'removeNode', node: 'Check' }] } }] },
      { toolCalls: [{ id: 'c2', name: 'get_workflow', input: {} }] },
      // It wanders off and puts the node back, by name and then as another node of the same type.
      { toolCalls: [{ id: 'c3', name: 'propose_changes', input: { summary: 'Add a check', ops: [{ op: 'addNode', type: 'core.if', name: 'Check', after: 'Code' }] } }] },
      { toolCalls: [{ id: 'c4', name: 'propose_changes', input: { summary: 'Add a filter', ops: [{ op: 'addNode', type: 'core.if', name: 'Is it valid', after: 'Code' }] } }] },
      { text: 'Done.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Remove the Check node' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'proposal').map((e) => (e as { summary: string }).summary)).toEqual(['Remove Check']);
    const result = (call: number) => (calls[call].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content;
    expect(result(1)).toContain("if it's all proposed, stop");
    expect(result(2)).toContain('Removed by pending proposals');
    expect(result(2)).toContain('“Check” (core.if)');
    expect(result(3)).toContain('“Check” (core.if) is removed by a pending proposal');
    expect(result(4)).toContain('“Check” (core.if) is removed by a pending proposal');
  });

  it('adds a node by a removed node’s name when the request asks for a new one, not when it only removes it', async () => {
    const proposals = async (content: string) => {
      const { model } = scripted([
        { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Remove Check', ops: [{ op: 'removeNode', node: 'Check' }] } }] },
        { toolCalls: [{ id: 'c2', name: 'propose_changes', input: { summary: 'Add Check', ops: [{ op: 'addNode', type: 'core.if', name: 'Check', after: 'Code' }] } }] },
        { text: 'Done.' },
      ]);
      const events: ChatEvent[] = [];
      await runChat({ messages: [{ role: 'user', content }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
      return events.filter((e) => e.type === 'proposal').map((e) => (e as { summary: string }).summary);
    };
    expect(await proposals('Remove the Check node, then add a new Check after Code')).toEqual(['Remove Check', 'Add Check']);
    expect(await proposals('Add a note and remove the Check node')).toEqual(['Remove Check']);
  });

  it('adds a node of a removed node’s type when the request names that type', async () => {
    const { model } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Swap the If', ops: [{ op: 'removeNode', node: 'Check' }, { op: 'addNode', type: 'core.if', name: 'Is it valid', after: 'Code' }] } }] },
      { text: 'Done.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Replace Check with a new If node after Code' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
  });

  it('keeps an answer that proposed nothing as written', async () => {
    const { model } = scripted([{ text: 'The Set node has been updated in Landflow 0.2: it now keeps other fields.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'What changed in Set?' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    expect(events[0]).toEqual({ type: 'text', text: 'The Set node has been updated in Landflow 0.2: it now keeps other fields.' });
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

  it('sends back a replacement that removes a node but never adds the new one, and shows the complete one', async () => {
    // The live case: "replace X with an A2A Agent node" came back as remove X, connect to "r1" (never added) and a made-up type.
    const half = { summary: 'Swap Check', ops: [{ op: 'removeNode', node: 'Check' }, { op: 'addNode', ref: 'm', type: 'core.aiLanguageModel', name: 'Chat Model' }, { op: 'connect', from: 'Code', to: 'r1' }] };
    const whole = { summary: 'Swap Check', ops: [{ op: 'removeNode', node: 'Check' }, { op: 'addNode', ref: 'r1', type: 'core.if', name: 'Is it valid', after: 'Code' }] };
    const { model, calls } = scripted([{ toolCalls: [{ id: 'c1', name: 'propose_changes', input: half }] }, { toolCalls: [{ id: 'c2', name: 'propose_changes', input: whole }] }, { text: 'Done.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Replace Check with an If node' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    const back = (calls[1].messages.at(-1) as { results: Array<{ content: string }> }).results[0].content;
    expect(back).toContain('unknown node type core.aiLanguageModel');
    expect(back).toContain('no node “r1”');
    const proposals = events.filter((e) => e.type === 'proposal');
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ ops: [{ op: 'removeNode', node: 'Check' }, { op: 'addNode', type: 'core.if', name: 'Is it valid' }], dropped: [] });
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

  it('goes on while steps add something new, up to the ceiling', async () => {
    // Each search is new, so each step makes progress; the ceiling ends it.
    const { model, calls } = scripted(Array.from({ length: MAX_STEPS + 2 }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'search_nodes', input: { query: i % 2 ? 'sort items' : 'merge branches' } }, { id: `d${i}`, name: 'get_node_docs', input: { type: i % 2 ? 'core.sort' : 'core.merge' } }, { id: `e${i}`, name: 'get_run_data', input: { node: `Ghost ${i}` } }] })));
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Keep researching' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    // The ghost node's error message is different each time, so the steps are never all repeats.
    expect(calls).toHaveLength(MAX_STEPS);
    expect(events.at(-2)).toMatchObject({ type: 'text', text: expect.stringContaining(`Stopped after ${MAX_STEPS} steps`) });
    expect(events.at(-1)).toMatchObject({ type: 'done', steps: MAX_STEPS });
  });

  it('stops early when steps only repeat', async () => {
    const { model, calls } = scripted(Array.from({ length: MAX_STEPS }, (_, i) => ({ toolCalls: [{ id: `c${i}`, name: 'get_workflow', input: {} }] })));
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Loop forever' }], workflow: workflow(), model, types, onEvent: (e) => events.push(e) });
    // The first read is new; the next two are not.
    expect(calls).toHaveLength(3);
    expect(events.at(-2)).toMatchObject({ type: 'text', text: expect.stringContaining('only repeated') });
    expect(events.at(-2)).not.toMatchObject({ text: expect.stringContaining('Stopped after') });
  });
});

/** Start → Brief → Create branch → Tech Lead → Open draft PR, the flow of the live test. */
function delivery(): Workflow {
  const node = (id: string, name: string, type: string, x: number, parameters: Record<string, unknown> = {}) => ({ id, name, type, typeVersion: 1, position: [x, 0] as [number, number], parameters });
  const edge = (a: string, b: string) => ({ id: `${a}${b}`, type: 'main' as const, source: a, sourceIndex: 0, target: b, targetIndex: 0 });
  return {
    id: 'wf_delivery',
    name: 'Delivery',
    nodes: [node('t', 'Start', 'core.manualTrigger', 0), node('b', 'Brief', 'core.set', 280), node('c', 'Create branch', 'core.set', 560), node('l', 'Tech Lead', 'core.set', 840), node('d', 'Open draft PR', 'core.set', 1120)],
    connections: [edge('t', 'b'), edge('b', 'c'), edge('c', 'l'), edge('l', 'd')],
  };
}

const proposalsOf = (events: ChatEvent[]) => events.filter((e): e is Extract<ChatEvent, { type: 'proposal' }> => e.type === 'proposal');
const toolResults = (calls: GenerateInput[], index: number) => (calls[index].messages.at(-1) as { results: Array<{ content: string; isError?: boolean }> }).results;

describe('multi-part requests, pending proposals, branches and loops', () => {
  it('reads the ops shapes local models send: an array, one op, JSON text, a wrapper', () => {
    const add = { op: 'addNode', type: 'core.noOp', name: 'X' };
    expect(opsArgument([add])).toEqual([add]);
    expect(opsArgument(add)).toEqual([add]);
    expect(opsArgument(JSON.stringify([add]))).toEqual([add]);
    expect(opsArgument(JSON.stringify(add))).toEqual([add]);
    expect(opsArgument({ ops: [add] })).toEqual([add]);
    expect(opsArgument('[{op: addNode')).toEqual([]);
  });

  it('reads a ref from an earlier proposal in the same reply as that node’s name', () => {
    const refs = new Map([['run_report', 'Run report']]);
    const ops = withEarlierRefs(
      [
        { op: 'connect', from: 'Tech Lead', to: 'run_report' },
        { op: 'addNode', ref: 'gate', type: 'core.if', name: 'Rounds left?', after: 'run_report', output: 1 },
        { op: 'connect', from: 'gate', to: 'Open PR' },
      ],
      refs,
    );
    expect(ops).toEqual([
      { op: 'connect', from: 'Tech Lead', to: 'Run report' },
      { op: 'addNode', ref: 'gate', type: 'core.if', name: 'Rounds left?', after: 'Run report', output: 1 },
      { op: 'connect', from: 'gate', to: 'Open PR' },
    ]);
  });

  it('does not branch where a node already branches, but still accepts it when asked for twice', async () => {
    const wf = delivery();
    const filter = { summary: 'Check', ops: [{ op: 'addNode', ref: 'rr', type: 'core.runReport', name: 'Run report', after: 'Tech Lead', parameters: { gate: 'route' } }, { op: 'addNode', type: 'core.filter', name: 'Check if passed', after: 'rr' }] };
    const { model, calls } = scripted([{ toolCalls: [{ id: 'c1', name: 'propose_changes', input: filter }] }, { toolCalls: [{ id: 'c2', name: 'propose_changes', input: filter }] }, { text: 'Review it.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Add a run report' }], workflow: wf, model, types, onEvent: (e) => events.push(e) });
    const [first] = toolResults(calls, 1);
    expect(first.isError).toBe(true);
    expect(first.content).toContain('Run report already branches: output 0 “Passed”, output 1 “Send back”. Connect from those outputs instead');
    // Sent back once: the same proposal the second time goes through.
    expect(proposalsOf(events)).toHaveLength(1);
  });

  it('answers a call with no ops after a proposal: the person applies, connect by name; a ref carries over', async () => {
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Report', ops: [{ op: 'addNode', ref: 'rr', type: 'core.runReport', name: 'Run report', after: 'Tech Lead', parameters: { gate: 'route' } }] } }] },
      { toolCalls: [{ id: 'c2', name: 'propose_changes', input: { summary: 'Apply the report first' } }] },
      { toolCalls: [{ id: 'c3', name: 'propose_changes', input: { summary: 'Passed', ops: { op: 'addNode', ref: 'pr', type: 'core.set', name: 'Open ready PR', after: 'rr', output: 0 } } }] },
      { text: 'Done.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Add a run report, then open a PR when it passes' }], workflow: delivery(), model, types, onEvent: (e) => events.push(e) });
    const [empty] = toolResults(calls, 2);
    expect(empty.isError).toBe(true);
    expect(empty.content).toContain("You can't apply proposals");
    expect(empty.content).toContain('“Run report” is already in the workflow you work on');
    // The third call used the first proposal's ref, as one op, not in an array: it goes through, after “Run report”.
    expect(proposalsOf(events).map((p) => p.ops)).toEqual([
      [expect.objectContaining({ op: 'addNode', name: 'Run report' })],
      [expect.objectContaining({ op: 'addNode', name: 'Open ready PR', after: 'Run report' })],
    ]);
  });

  it('reads `name` as the node of a removeNode or setParameters', () => {
    expect(parseOps([{ op: 'removeNode', name: 'Run Report' }, { op: 'setParameters', name: 'Brief', parameters: { a: 1 } }]).ops).toEqual([
      { op: 'removeNode', node: 'Run Report' },
      { op: 'setParameters', node: 'Brief', parameters: { a: 1 } },
    ]);
  });

  it('lists each node’s outputs and what they feed in get_workflow', async () => {
    const { model, calls } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Report', ops: [{ op: 'addNode', ref: 'rr', type: 'core.runReport', name: 'Run report', after: 'Tech Lead', parameters: { gate: 'route' } }, { op: 'addNode', ref: 'pr', type: 'core.set', name: 'Open ready PR', after: 'rr', output: 0 }] } }] },
      { toolCalls: [{ id: 'c2', name: 'get_workflow', input: {} }] },
      { text: 'Done.' },
    ]);
    await runChat({ messages: [{ role: 'user', content: 'Add a run report' }], workflow: delivery(), model, types, onEvent: () => {} });
    const outline = toolResults(calls, 2)[0].content;
    expect(outline).toContain('branches: output 0 “Passed” → “Open ready PR”; output 1 “Send back” → nothing yet');
    expect(outline).toContain('[pending: proposed, not applied yet]');
  });

  it('accepts a connection back to an earlier node as a loop, without a warning', () => {
    const wf = delivery();
    const before = apply([{ op: 'addNode', ref: 'n', type: 'core.code', name: 'Count rounds', after: 'Tech Lead' }, { op: 'addNode', ref: 'r', type: 'core.if', name: 'Round under 3', after: 'n' }], wf).workflow;
    const result = apply([{ op: 'connect', from: 'Round under 3', to: 'Tech Lead', output: 0 }], before);
    expect(result.dropped).toEqual([]);
    expect(result.applied).toEqual([{ op: 'connect', from: 'Round under 3', to: 'Tech Lead' }]);
    expect(structuralWarnings(before, result.workflow, lookup())).toEqual([]);
    // A second input from something that is not downstream still warns.
    const other = apply([{ op: 'connect', from: 'Brief', to: 'Tech Lead' }], before);
    expect(structuralWarnings(before, other.workflow, lookup())).toEqual(['“Tech Lead” now gets input from both “Create branch” and “Brief”']);
  });

  it('replays the live test: a multi-part proposal, a pending one not repeated, a Filter sent back, a loop', async () => {
    const request = 'Add a Run report node after the Tech Lead (gate: route). If it passes: open a ready PR, comment, merge. If it sends back: loop to the Tech Lead up to 3 rounds, then open a draft PR.';
    const plan = [
      { op: 'addNode', ref: 'rr', type: 'core.runReport', name: 'Run report', after: 'Tech Lead', parameters: { gate: 'route' } },
      { op: 'addNode', ref: 'ready', type: 'core.set', name: 'Open ready PR', after: 'rr', output: 0 },
      { op: 'addNode', ref: 'comment', type: 'core.set', name: 'Comment on PR', after: 'ready' },
      { op: 'addNode', ref: 'merge', type: 'core.set', name: 'Merge PR', after: 'comment' },
      { op: 'addNode', ref: 'count', type: 'core.code', name: 'Count rounds', after: 'rr', output: 1 },
      { op: 'addNode', ref: 'more', type: 'core.if', name: 'Round under 3', after: 'count' },
      { op: 'connect', from: 'more', to: 'Tech Lead', output: 0 },
      { op: 'disconnect', from: 'Tech Lead', to: 'Open draft PR' },
      { op: 'connect', from: 'more', to: 'Open draft PR', output: 1 },
    ];
    // Reply 1: a Filter after the report goes back; then the whole plan goes in one proposal, with the loop.
    const first = scripted([
      { text: '1. Run report. 2. Passed: ready PR, comment, merge. 3. Send back: count, loop, draft PR.', toolCalls: [{ id: 'a1', name: 'propose_changes', input: { summary: 'Report and check', ops: [plan[0], { op: 'addNode', type: 'core.filter', name: 'Check if passed', after: 'rr' }] } }] },
      { toolCalls: [{ id: 'a2', name: 'propose_changes', input: { summary: 'Run report with both sides and the loop', ops: plan } }] },
      { text: 'Review the card and click Apply.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: request }], workflow: delivery(), model: first.model, types, onEvent: (e) => events.push(e) });
    expect(toolResults(first.calls, 1)[0].content).toContain('Run report already branches');
    const [proposal] = proposalsOf(events);
    expect(proposalsOf(events)).toHaveLength(1);
    expect(proposal.ops.map((op) => op.op)).toEqual(['addNode', 'addNode', 'addNode', 'addNode', 'addNode', 'addNode', 'connect', 'disconnect', 'connect']);
    expect(proposal.dropped).toEqual([]);
    expect(proposal.warnings).toEqual([]);
    expect(proposal.ops.some((op) => op.op === 'addNode' && op.type === 'core.filter')).toBe(false);
    expect(proposal.ops).toContainEqual({ op: 'connect', from: 'more', to: 'Tech Lead' });

    // Reply 2: the proposal is still pending. The model proposes it again, then adds only what is missing.
    const second = scripted([
      { toolCalls: [{ id: 'b1', name: 'propose_changes', input: { summary: 'Run report', ops: [plan[0], plan[1]] } }] },
      { toolCalls: [{ id: 'b2', name: 'propose_changes', input: { summary: 'Notify', ops: [{ op: 'addNode', ref: 'n', type: 'core.set', name: 'Notify', after: 'Merge PR' }] } }] },
      { text: 'Review the card.' },
    ]);
    const again: ChatEvent[] = [];
    await runChat({
      messages: [{ role: 'user', content: request }, { role: 'assistant', content: '[Proposed “Run report with both sides and the loop”: not applied yet]' }, { role: 'user', content: 'Also notify after the merge' }],
      workflow: delivery(),
      pending: [{ summary: proposal.summary, ops: proposal.ops }],
      model: second.model,
      types,
      onEvent: (e) => again.push(e),
    });
    // The model sees the pending nodes as part of the workflow, and the repeated proposal is skipped.
    expect(second.calls[0].system).toContain('Open ready PR” (core.set) [pending: proposed, not applied yet]');
    expect(second.calls[0].system).toContain('Pending proposals');
    expect(toolResults(second.calls, 1)[0].content).toMatch(/^Nothing changes: “Run report” was proposed earlier/);
    const [notify] = proposalsOf(again);
    expect(proposalsOf(again)).toHaveLength(1);
    expect(notify.ops).toEqual([{ op: 'addNode', ref: 'n', type: 'core.set', name: 'Notify', after: 'Merge PR' }]);
  });
});

describe('warnings for made-up references and missing service credentials', () => {
  afterEach(() => vi.restoreAllMocks());
  const insert = (id: string): AssistantOp[] => [{ op: 'addNode', ref: 't', type: 'core.dataTable', name: 'Save row', after: 'Code', parameters: { operation: 'insert', dataTableId: id } }];

  it('warns when a data table id is not in the real list, and stays quiet for a real one or an expression', async () => {
    const spy = vi.spyOn(registry, 'loadOptions').mockResolvedValue([{ name: 'Leads', value: 'tbl_real' }]);
    const check = async (id: string) => {
      const v = validateOps(workflow(), insert(id), lookup());
      return unknownReferenceCautions(workflow(), v.workflow, lookup());
    };
    const made = await check('table_12345');
    expect(made).toHaveLength(1);
    expect(made[0]).toMatch(/Data Table “table_12345” is not one of the 1 that exist \(tbl_real\)/);
    expect(await check('tbl_real')).toEqual([]);
    expect(await check('={{ $json.table }}')).toEqual([]);
    expect(spy).toHaveBeenCalled();
  });

  it('claims nothing when the list cannot be loaded or is empty', async () => {
    const spy = vi.spyOn(registry, 'loadOptions').mockRejectedValue(new Error('needs a credential'));
    const v = validateOps(workflow(), insert('table_12345'), lookup());
    expect(await unknownReferenceCautions(workflow(), v.workflow, lookup())).toEqual([]);
    spy.mockResolvedValue([]);
    expect(await unknownReferenceCautions(workflow(), v.workflow, lookup())).toEqual([]);
  });

  it('warns for an HTTP Request to a known service host with no credential, not with one or an auth header or another host', () => {
    const http = (parameters: Record<string, unknown>): AssistantOp[] => [{ op: 'addNode', ref: 'h', type: 'core.httpRequest', name: 'Post to Slack', after: 'Code', parameters }];
    const slack = validateOps(workflow(), http({ method: 'POST', url: 'https://slack.com/api/chat.postMessage' }), lookup());
    expect(slack.cautions.some((c) => /“Post to Slack” calls Slack \(slack\.com\) with no credential/.test(c))).toBe(true);
    const other = validateOps(workflow(), http({ url: 'https://example.org/hook' }), lookup());
    expect(other.cautions.some((c) => /calls .* with no credential/.test(c))).toBe(false);
    const hdr = validateOps(workflow(), http({ url: 'https://slack.com/api/x', headers: { header: [{ name: 'Authorization', value: 'Bearer x' }] } }), lookup());
    expect(hdr.cautions.some((c) => /calls Slack/.test(c))).toBe(false);
  });
});
