/**
 * SB10: what the chat's model reads about the steps it edits: a step's parameters whole, its settings and credential
 * state (names only), the outline's full parameters for the steps in scope, the output fields of the operation a step
 * selects, and `setWorkflowSettings` in the op list the chat offers.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { runChat, TOOLS, type ChatEvent } from '@/lib/server/assistant/chat';
import { nodeContext, outputFields, workflowOutline } from '@/lib/server/assistant/research';
import { Linear } from '../../../plugins/linear/src/nodes/linear';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const LONG = `${Array.from({ length: 150 }, (_, i) => `// line ${i}: keep this`).join('\n')}\nreturn { last: 'the final line' };`;
const flow = (over: Partial<Workflow['nodes'][number]> = {}): Workflow => ({
  id: 'wf_ctx',
  name: 'Ctx',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Parse triage', type: 'core.code', typeVersion: 1, position: [280, 0], parameters: { mode: 'each', codeEach: LONG }, ...over },
    { id: 'c', name: 'Call API', type: 'core.httpRequest', typeVersion: 1, position: [560, 0], parameters: { url: 'http://127.0.0.1:3000/x', authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } },
  ],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
});

describe('nodeContext with full', () => {
  it('holds the last line of a 6 000 character Code step, where the default cuts it at 2 000', () => {
    const wf = flow();
    expect(LONG.length).toBeGreaterThan(2500);
    expect(nodeContext(wf, 'b', undefined, types)).not.toContain('the final line');
    expect(nodeContext(wf, 'b', undefined, types, { full: true })).toContain('the final line');
  });

  it('cuts one huge string at 8 000 characters and says how many more', () => {
    const wf = flow({ parameters: { mode: 'each', codeEach: 'x'.repeat(20_000) } });
    const text = nodeContext(wf, 'b', undefined, types, { full: true });
    expect(text).toContain('… (12000 more characters)');
    expect(text.length).toBeLessThan(20_000);
  });

  it('lists the settings that are set, else "defaults"', () => {
    expect(nodeContext(flow({ retryOnFail: true, maxTries: 3 }), 'b', undefined, types, { full: true })).toMatch(/Settings: retryOnFail: true, maxTries: 3\n/);
    expect(nodeContext(flow(), 'b', undefined, types, { full: true })).toContain('Settings: defaults');
  });

  it('says "not set" for an empty credential slot, and names the credential when set (never its id)', () => {
    const wf = flow();
    expect(nodeContext(wf, 'c', undefined, types, { full: true })).toContain('httpHeaderAuth: not set');
    wf.nodes[2] = { ...wf.nodes[2], credentials: { httpHeaderAuth: { id: 'cred_secret_id_123', name: 'Echo token' } } };
    const text = nodeContext(wf, 'c', undefined, types, { full: true });
    expect(text).toContain('httpHeaderAuth: set (“Echo token”)');
    expect(text).not.toContain('cred_secret_id_123');
  });
});

describe('workflowOutline with full', () => {
  it('gives the steps in scope 2 000 characters of parameters and the others 300', () => {
    const wf = flow();
    wf.nodes[2] = { ...wf.nodes[2], parameters: { ...wf.nodes[2].parameters, body: 'y'.repeat(1000) } };
    const outline = workflowOutline(wf, {}, { types, full: new Set(['b', 'c']) });
    const line = (name: string) => outline.split('\n').find((l) => l.startsWith(`- “${name}”`))!;
    expect(line('Parse triage').length).toBeGreaterThan(1900);
    expect(line('Parse triage').length).toBeLessThan(2200);
    expect(line('Call API')).toContain('y'.repeat(500));
    const narrow = workflowOutline(wf, {}, { types, full: new Set(['c']) });
    const parse = narrow.split('\n').find((l) => l.startsWith('- “Parse triage”'))!;
    expect(parse.length).toBeLessThan(450);
  });
});

describe('outputFields reads the operation the parameters select', () => {
  it('Linear issue → get gives that operation’s schema, create gives the new issue’s fields, a bare descriptor gives none', () => {
    const d = Linear.description as NodeTypeInfo['descriptor'];
    expect(outputFields(d)).toBe('');
    expect(outputFields(d, { resource: 'issue', operation: 'get' })).toContain('text');
    const created = outputFields(d, { resource: 'issue', operation: 'create' });
    expect(created).toContain('url (string) — Link to the new issue in Linear');
    expect(created).toContain('identifier');
    // The same operation name under another resource is another schema (comment → create).
    expect(outputFields(d, { resource: 'comment', operation: 'create' })).toContain('createdAt');
  });
});

describe('the chat', () => {
  function scripted(turns: Array<Partial<ModelTurn>>) {
    const calls: GenerateInput[] = [];
    const model: LanguageModel = {
      provider: 'test',
      model: 'scripted',
      async generate(input) {
        calls.push({ ...input, messages: [...input.messages] });
        const next = turns.shift();
        if (!next) throw new Error('No scripted turn left');
        return { text: '', toolCalls: [], stopReason: 'stop', ...next };
      },
    };
    return { model, calls };
  }

  it('shows the selected step’s whole code, its settings and credential state in the system prompt', async () => {
    const { model, calls } = scripted([{ text: 'Looks fine.' }]);
    await runChat({ messages: [{ role: 'user', content: 'what does Parse triage do?' }], workflow: flow({ retryOnFail: true, maxTries: 3 }), selectedNodeId: 'b', model, types, onEvent: () => undefined });
    const system = calls[0].system as string;
    expect(system).toContain('the final line');
    expect(system).toContain('Settings: retryOnFail: true, maxTries: 3');
  });

  it('shows the steps a sent scope names in full, not only the selected one', async () => {
    const { model, calls } = scripted([{ text: 'ok' }]);
    const wf = flow();
    wf.nodes[2] = { ...wf.nodes[2], parameters: { ...wf.nodes[2].parameters, body: `${'z'.repeat(900)}END` } };
    await runChat({ messages: [{ role: 'user', content: 'change Call API' }], workflow: wf, selectedNodeId: 'b', scope: { kind: 'tagged', nodes: ['c'] }, model, types, onEvent: () => undefined } as never);
    expect(calls[0].system as string).toContain('httpHeaderAuth: not set');
  });

  it('caps the parameter text of all the steps given whole at 24 000 characters, the selected step first (SB10-N8)', async () => {
    const { model, calls } = scripted([{ text: 'ok' }]);
    const big = (id: string, name: string, ch: string) => ({ id, name, type: 'core.code', typeVersion: 1, position: [0, 0] as [number, number], parameters: { mode: 'each', codeEach: ch.repeat(8000), notes: ch.repeat(8000) } });
    const wf: Workflow = { ...flow(), nodes: [...flow().nodes, big('d', 'Step D', 'd'), big('e', 'Step E', 'e'), big('f', 'Step F', 'f')] };
    wf.nodes[1] = big('b', 'Parse triage', 'b');
    await runChat({ messages: [{ role: 'user', content: 'change Step D, Step E and Step F' }], workflow: wf, selectedNodeId: 'b', scope: { kind: 'tagged', nodes: ['d', 'e', 'f'] }, model, types, onEvent: () => undefined } as never);
    const system = calls[0].system as string;
    const count = (ch: string) => system.split('\n').filter((l) => l.startsWith('Parameters: ')).reduce((n, l) => n + (l.match(new RegExp(ch, 'g'))?.length ?? 0), 0);
    expect(count('b')).toBeGreaterThan(11_000); // the selected step first, up to 12 000
    expect(count('d')).toBeGreaterThan(9_000);
    expect(count('b') + count('d') + count('e') + count('f')).toBeLessThanOrEqual(24_000);
    expect(count('f')).toBe(0);
    expect(system).toContain('more characters');
  });

  it('offers setWorkflowSettings in its tools and gives a proposal for { timeoutSeconds: 300 }', async () => {
    const propose = TOOLS.find((t) => t.name === 'propose_changes')!;
    expect(JSON.stringify(propose.inputSchema)).toContain('setWorkflowSettings');
    const { model, calls } = scripted([
      { text: '', toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Stop after 5 minutes', ops: [{ op: 'setWorkflowSettings', settings: { timeoutSeconds: 300 } }] } }], stopReason: 'tool_use' },
      { text: 'The workflow stops after 5 minutes.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'stop the workflow if it runs longer than 5 minutes' }], workflow: flow(), model, types, onEvent: (e) => events.push(e) });
    expect(calls[0].system as string).toContain('"op":"setWorkflowSettings"');
    const proposals = events.filter((e) => e.type === 'proposal') as Array<Extract<ChatEvent, { type: 'proposal' }>>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0].ops).toEqual([{ op: 'setWorkflowSettings', settings: { timeoutSeconds: 300 } }]);
  });
});
