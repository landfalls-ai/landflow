import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { readSuggestions, suggestAfterRun } from '@/lib/server/assistant/suggest';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const workflow = (): Workflow => ({
  id: 'wf_block',
  name: 'Block',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'h', name: 'Send to echo', type: 'core.httpRequest', typeVersion: 1, position: [280, 0], parameters: { method: 'POST', url: 'http://127.0.0.1:3415/vip', authentication: 'none', headers: {} } },
  ],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'h', targetIndex: 0 }],
});

function scripted(turns: Array<Partial<ModelTurn>>) {
  const calls: unknown[] = [];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate(input) {
      calls.push(input);
      return { text: '', toolCalls: [], stopReason: 'stop', ...(turns.shift() ?? { text: '{"suggestions":[]}' }) };
    },
  };
  return { model, calls };
}

const blocked = { status: 'error', durationMs: 3, error: { message: 'Blocked: 127.0.0.1 resolves to a private address (LANDFLOW_OUTBOUND_ALLOW lists exceptions)' }, inputs: [{ count: 1, sample: [{}] }], outputs: [] };

describe('after a host block', () => {
  it('skips with no model call', async () => {
    const { model, calls } = scripted([{ text: '{"suggestions":[{"kind":"fix","title":"Change localhost URL to external address","detail":"x","confidence":0.9,"ops":[{"op":"setParameters","node":"Send to echo","parameters":{"url":"https://httpbin.org/post"}}]}]}' }]);
    const result = await suggestAfterRun({ workflow: workflow(), nodeId: 'h', run: blocked, model, types });
    expect(result.suggestions).toEqual([]);
    expect(result.skipped).toBe('This host blocks that address: only an admin can allow it');
    expect(calls).toHaveLength(0);
  });

  it('a fix that moves the URL to another host keeps its words and loses its ops, and its title', () => {
    const reply = JSON.stringify({ suggestions: [{ kind: 'fix', title: 'Change localhost URL to external address', detail: 'Use a public endpoint.', confidence: 0.9, ops: [{ op: 'setParameters', node: 'Send to echo', parameters: { url: 'https://httpbin.org/post' } }] }] });
    const [s] = readSuggestions(reply, workflow(), types);
    expect(s.ops).toEqual([]);
    expect(s.detail).toBe('Use a public endpoint.');
    expect(s.title).not.toMatch(/external|public|httpbin/i);
  });

  it('a fix that changes only a header keeps its ops', () => {
    const reply = JSON.stringify({ suggestions: [{ kind: 'fix', title: 'Set the content type', detail: 'JSON.', confidence: 0.9, ops: [{ op: 'setParameters', node: 'Send to echo', parameters: { headers: { header: [{ name: 'Content-Type', value: 'application/json' }] } } }] }] });
    const [s] = readSuggestions(reply, workflow(), types);
    expect(s.ops).toHaveLength(1);
    expect(s.title).toBe('Set the content type');
  });
});
