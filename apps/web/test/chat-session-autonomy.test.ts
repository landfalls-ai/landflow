/** Wave sb1 review fixes: a session's prompt and its tool result say what Spotlight does with the proposal, by autonomy. */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { PERSON_ONLY } from '@/lib/server/assistant/guards';
import { runChat } from '@/lib/server/assistant/chat';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

const flow = (): Workflow => ({ id: 'wf', name: 'W', nodes: [{ id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} }], connections: [] });
const propose: Partial<ModelTurn> = { toolCalls: [{ id: 'c', name: 'propose_changes', input: { summary: 'Add a step', ops: [{ op: 'addNode', ref: 'n', type: 'core.noOp', name: 'Done', after: 'Start' }] } }] };

async function session(autonomy: 'auto' | 'asks-first' | undefined, kind: 'review' | 'auto' = 'review') {
  const systems: string[] = [];
  const results: string[] = [];
  const steps: Array<Partial<ModelTurn>> = [propose, { text: 'Done.' }];
  const model: LanguageModel = {
    provider: 'ollama',
    model: 'scripted',
    async generate(input) {
      systems.push(String(input.system));
      results.push(JSON.stringify(input.messages));
      return { text: '', toolCalls: [], stopReason: 'stop', ...(steps.shift() ?? { text: 'Done.' }) } as ModelTurn;
    },
  };
  await runChat({ messages: [{ role: 'user', content: 'Test run 1 had no errors. Does that do what I asked for? If not, fix it.' }], workflow: flow(), model, types, session: kind, ...(autonomy && { autonomy }), onEvent: () => undefined });
  return { system: systems[0], results: results.join('\n'), all: JSON.stringify(systems) };
}

describe('a session says what happens to the proposal', () => {
  it('asks-first (and no autonomy at all): the proposal is a card that waits for Apply, nothing applies itself', async () => {
    for (const autonomy of ['asks-first', undefined] as const) {
      const { system } = await session(autonomy);
      expect(system).toContain('shown to the person as a card');
      expect(system).not.toContain('applies your proposal');
    }
  });

  it('auto: Spotlight applies it itself', async () => {
    const { system } = await session('auto');
    expect(system).toContain('applies your proposal and runs the workflow again by itself');
  });

  it('the tool result does not claim an asks-first fix is applied by itself', async () => {
    const asks = await session('asks-first');
    expect(asks.all + asks.results).not.toContain('Spotlight applies it when you finish');
    expect(asks.all + asks.results).toContain('it waits for the person to apply it');
    const auto = await session('auto');
    expect(auto.all + auto.results).toContain('Spotlight applies it when you finish');
  });

  it('the autonomous prompt keeps the person\'s values unless they ask for the change in this message', async () => {
    const { system } = await session(undefined, 'auto');
    expect(system).toContain('unless they ask for it in this message');
  });
});

describe('PERSON_ONLY (review fixes)', () => {
  it('reads the host\'s policy wording, not the bare word "blocked"', () => {
    expect(PERSON_ONLY.test('The step is blocked by this host: an admin can allow it.')).toBe(true);
    expect(PERSON_ONLY.test('Blocked by the host\'s outbound policy.')).toBe(true);
    expect(PERSON_ONLY.test('The branch is blocked because the Merge waits for both inputs.')).toBe(false);
    expect(PERSON_ONLY.test('Pick the credential.')).toBe(true);
  });
});
