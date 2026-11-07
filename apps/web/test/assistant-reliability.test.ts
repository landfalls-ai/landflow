import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { NodeTypeInfo } from '@/lib/shared/types';
import type { GenerateInput } from '@/lib/server/nodes/models';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';
import { registryLookup, validateOps } from '@/lib/server/assistant/ops';

// Regression fixtures from building the seven-node form flow with Spotlight (docs/specs/17-parallel-build-plan.md, W4).

let types: NodeTypeInfo[];
const lookup = () => registryLookup(types);

beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
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

/** Start → Code. */
const simple = (): Workflow => ({
  id: 'wf_test',
  name: 'Test',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'b', name: 'Code', type: 'core.code', typeVersion: 1, position: [280, 0], parameters: { mode: 'each', codeEach: 'return $json;' } },
  ],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'b', targetIndex: 0 }],
});

/** Start → Check (If): output 0 (approved) → Notify, output 1 (rejected) → Reject. */
const branched = (): Workflow => ({
  id: 'wf_form',
  name: 'Form',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'c', name: 'Check', type: 'core.if', typeVersion: 1, position: [280, 0], parameters: {} },
    { id: 'n', name: 'Notify', type: 'core.set', typeVersion: 1, position: [560, 0], parameters: {} },
    { id: 'r', name: 'Reject', type: 'core.set', typeVersion: 1, position: [560, 170], parameters: {} },
  ],
  connections: [
    { id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'c', targetIndex: 0 },
    { id: 'e2', type: 'main', source: 'c', sourceIndex: 0, target: 'n', targetIndex: 0 },
    { id: 'e3', type: 'main', source: 'c', sourceIndex: 1, target: 'r', targetIndex: 0 },
  ],
});

describe('wiring checks after a build', () => {
  it('flags the success branch wired into the rejection', () => {
    const result = validateOps(branched(), [{ op: 'connect', from: 'Check', to: 'Reject', output: 0 }], lookup());
    expect(result.warnings).toContain('“Reject” is reached from both output 0 and output 1 of “Check”: one branch leads into the other');
  });

  it('does not flag a clean branch or a deliberate merge', () => {
    expect(validateOps(branched(), [{ op: 'addNode', type: 'core.set', name: 'After', after: 'Notify' }], lookup()).warnings).toEqual([]);
    const merged = validateOps(branched(), [{ op: 'addNode', ref: 'm', type: 'core.merge', name: 'Join', after: 'Notify' }, { op: 'connect', from: 'Reject', to: 'm' }], lookup());
    expect(merged.warnings).toEqual([]);
  });

  it('does not mistake a loop back to the branching node for two branches meeting', () => {
    const result = validateOps(branched(), [{ op: 'connect', from: 'Notify', to: 'Check' }, { op: 'connect', from: 'Reject', to: 'Check' }], lookup());
    expect(result.warnings.filter((w) => w.includes('one branch leads'))).toEqual([]);
  });

  it('flags a stray node nothing reads, but not a final node', () => {
    const stray = validateOps(branched(), [{ op: 'addNode', type: 'core.set', name: 'Stray', after: 'Check', output: 0 }], lookup());
    expect(stray.cautions).toEqual(['new node “Stray” has no purpose: nothing reads its output']);
    const lonely = validateOps(branched(), [{ op: 'addNode', type: 'core.if', name: 'Lonely check', after: 'Notify' }], lookup());
    expect(lonely.cautions).toEqual(['new node “Lonely check” has no purpose: nothing reads its output']);
    const last = validateOps(branched(), [{ op: 'addNode', type: 'core.set', name: 'Final', after: 'Notify' }], lookup());
    expect(last.cautions).toEqual([]);
  });
});

describe('a fix that hides the error', () => {
  it('is a caution on the validated change', () => {
    const settings = validateOps(simple(), [{ op: 'setNodeSettings', node: 'Code', settings: { onError: 'continue' } }], lookup());
    expect(settings.cautions).toEqual(['“Code” is set to continue on error: the failure is hidden, not fixed']);
    const swallow = validateOps(simple(), [{ op: 'setParameters', node: 'Code', parameters: { codeEach: 'try { return risky($json); } catch (e) { return { ok: true }; }' } }], lookup());
    expect(swallow.cautions).toEqual(['“Code” catches its error and returns normally: the failure is hidden, not fixed']);
  });

  it('is not raised for a real fix or a retry', () => {
    const real = validateOps(simple(), [{ op: 'setParameters', node: 'Code', parameters: { codeEach: 'return { ...$json, total: Number($json.total) };' } }], lookup());
    expect(real.cautions).toEqual([]);
    const retry = validateOps(simple(), [{ op: 'setNodeSettings', node: 'Code', settings: { retryOnFail: true } }], lookup());
    expect(retry.cautions).toEqual([]);
  });

  it('shows on the proposal card', async () => {
    const { model } = scripted([
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Fix Code', ops: [{ op: 'setNodeSettings', node: 'Code', settings: { onError: 'continue' } }] } }] },
      { text: 'Done.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Code fails, fix it' }], workflow: simple(), model, types, onEvent: (e) => events.push(e) });
    expect(events.find((e) => e.type === 'proposal')).toMatchObject({ warnings: ['“Code” is set to continue on error: the failure is hidden, not fixed'] });
  });
});

describe('an announced card that never appeared', () => {
  it('says so and retries once when the reply says to apply and nothing was proposed', async () => {
    const { model, calls } = scripted([
      { text: 'I have prepared the change. Click Apply to add the node.' },
      { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Dedupe', ops: [{ op: 'addNode', type: 'core.removeDuplicates', name: 'Dedupe', after: 'Code' }] } }] },
      { text: 'Review the card.' },
    ]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Remove duplicates' }], workflow: simple(), model, types, onEvent: (e) => events.push(e) });
    expect(calls).toHaveLength(3);
    expect(events.some((e) => e.type === 'text' && e.text.includes('No change card was created'))).toBe(true);
    expect(events.some((e) => e.type === 'proposal')).toBe(true);
  });

  it('retries only once, then says there is still nothing to apply', async () => {
    const { model, calls } = scripted([{ text: 'Click Apply to add it.' }, { text: 'Now click Apply, really.' }]);
    const events: ChatEvent[] = [];
    await runChat({ messages: [{ role: 'user', content: 'Remove duplicates' }], workflow: simple(), model, types, onEvent: (e) => events.push(e) });
    expect(calls).toHaveLength(2);
    expect(events.some((e) => e.type === 'text' && e.text.includes('Still no change card'))).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });
});
