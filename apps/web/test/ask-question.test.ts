/**
 * A question is answered, not applied (finding 2.1, assistant/chat.ts): the model is not offered propose_changes for a
 * question, a propose_changes it writes as text is refused with no card, and `session: 'auto'` on a question is ignored.
 * A change message still offers it. The model is scripted: nothing leaves this machine.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const workflow = (): Workflow => ({
  id: 'wf_q',
  name: 'Q',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Code', type: 'core.code', typeVersion: 1, position: [280, 0], parameters: { mode: 'each', codeEach: 'return $json;' } },
  ],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
});

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

const asText = '<function=propose_changes><parameter=summary>Removed Code</parameter><parameter=ops>[{"op":"removeNode","node":"Code"}]</parameter></function>';

describe('a question is answered', () => {
  it('offers no propose_changes, refuses one written as text with no card, and ignores session auto', async () => {
    const { model, calls } = scripted([{ text: asText }, { text: 'Code got no input. Start sends nothing.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'why did the last run fail?' }], workflow: workflow(), session: 'auto', model, types, onEvent: (e) => events.push(e) });
    for (const call of calls) expect((call.tools ?? []).map((t) => t.name)).not.toContain('propose_changes');
    expect((calls[0].tools ?? []).map((t) => t.name)).toContain('get_run_data');
    expect(calls[0].system).toContain('The latest message is a question');
    // `auto` is ignored: the model is not told its proposal is applied.
    expect(calls[0].system).not.toContain('Autonomous mode: Spotlight applies');
    expect(events.filter((e) => e.type === 'proposal')).toEqual([]);
    expect(JSON.stringify(calls[1].messages)).toContain('Not offered: this is a question.');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text)).toContain('Code got no input. Start sends nothing.');
  });

  it('still offers propose_changes for a change, and a proposal arrives', async () => {
    const { model, calls } = scripted([{ text: asText }, { text: 'Removed it.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'remove the Code node' }], workflow: workflow(), session: 'auto', model, types, onEvent: (e) => events.push(e) });
    expect((calls[0].tools ?? []).map((t) => t.name)).toContain('propose_changes');
    expect(calls[0].system).toContain('Autonomous mode: Spotlight applies');
    expect(events.filter((e) => e.type === 'proposal')).toHaveLength(1);
  });

  it('still offers propose_changes for a condition with a comma clause ("When …, send …")', async () => {
    const { model, calls } = scripted([{ text: 'Nothing to do.' }]);
    await runChat({ messages: [{ role: 'user', content: 'When the total is over 100, send a Slack message' }], workflow: workflow(), model, types, onEvent: () => {} });
    expect((calls[0].tools ?? []).map((t) => t.name)).toContain('propose_changes');
  });

  it('never treats a test-and-fix session message as a question', async () => {
    const { model, calls } = scripted([{ text: 'Nothing to change.' }, { text: 'Only you can fix it, so nothing to change.' }]);
    await runChat({ messages: [{ role: 'user', content: 'Why did “Code” fail? It failed at run 1.' }], workflow: workflow(), session: 'fix', model, types, onEvent: () => {} });
    expect((calls[0].tools ?? []).map((t) => t.name)).toContain('propose_changes');
  });
});
