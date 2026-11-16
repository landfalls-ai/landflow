/**
 * SB12: a reply is never empty (finding 2.6), a change claimed with no card is caught (2.9), and a step that needs a
 * credential is offered to the person to pick, never set by Spotlight (2.10, decision D2). Scripted models, made-up data.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { LanguageModel, ModelTurn, Workflow } from '@landflow/engine';
import type { RunDigest } from '@/lib/shared/assistant-ops';
import type { NodeTypeInfo } from '@/lib/shared/types';
import { corePlugin } from '@/lib/server/nodes';
import { registry } from '@/lib/server/plugins/registry';
import { claimsAChange } from '@/lib/server/assistant/guards';
import { runChat, type ChatEvent } from '@/lib/server/assistant/chat';

let types: NodeTypeInfo[];
beforeAll(() => {
  registry.registerBuiltin(corePlugin);
  types = registry.nodeTypes().filter((t) => t.pluginId === 'core');
});

function scripted(turns: Array<Partial<ModelTurn>>) {
  const left = [...turns];
  const model: LanguageModel = {
    provider: 'test',
    model: 'scripted',
    async generate() {
      const next = left.shift();
      if (!next) throw new Error('No scripted turn left');
      return { text: '', toolCalls: [], stopReason: 'stop', ...next };
    },
  };
  return model;
}

const flow = (): Workflow => ({
  id: 'wf_claims',
  name: 'Claims',
  nodes: [
    { id: 'a', name: 'Start', type: 'core.manualTrigger', typeVersion: 1, position: [0, 0], parameters: {} },
    { id: 'h', name: 'Open status incident', type: 'core.httpRequest', typeVersion: 1, position: [280, 0], parameters: { method: 'POST', url: 'http://127.0.0.1:3399/incidents', authentication: 'none' } },
  ],
  connections: [{ id: 'e1', type: 'main', source: 'a', sourceIndex: 0, target: 'h', targetIndex: 0 }],
});

const run = async (ask: string, turns: Array<Partial<ModelTurn>>, extra: { workflow?: Workflow; runs?: Record<string, RunDigest>; selectedNodeId?: string } = {}) => {
  const events: ChatEvent[] = [];
  await runChat({ messages: [{ role: 'user', content: ask }], workflow: extra.workflow ?? flow(), model: scripted(turns), types, trace: true, ...(extra.runs && { runs: extra.runs }), ...(extra.selectedNodeId && { selectedNodeId: extra.selectedNodeId }), onEvent: (e) => events.push(e) });
  return events;
};
const lastText = (events: ChatEvent[]) => (events.filter((e) => e.type === 'text').at(-1) as { text: string } | undefined)?.text ?? '';

describe('claimsAChange', () => {
  it('is true for a change said to be made', () => {
    expect(claimsAChange("I've updated the URL")).toBe(true);
    expect(claimsAChange('The step now retries 3 times')).toBe(true);
    expect(claimsAChange('The retry has been set.')).toBe(true);
  });
  it('is false for a plan, a question, or a request to click Apply', () => {
    expect(claimsAChange('This would retry 3 times')).toBe(false);
    expect(claimsAChange('Should I change it?')).toBe(false);
    expect(claimsAChange('Click Apply to change it')).toBe(false);
  });
});

describe('the chat', () => {
  it('never ends empty: a last step that is only tool markup says why nothing changed', async () => {
    const events = await run('rename the first step to Begin', [{ text: '<tool_call></tool_call>' }]);
    const text = lastText(events);
    expect(text).not.toBe('');
    expect(text).toMatch(/^Nothing changed, because /);
  });

  it('sends a claimed change with no card back once, then says there is no card', async () => {
    const events = await run('retry the status call 3 times', [{ text: "I've set the retry to 3." }, { text: "I've set the retry to 3." }]);
    expect(events.filter((e) => e.type === 'thinking' || e.type === 'text').length).toBeGreaterThan(1);
    expect(lastText(events)).toContain('(Still no change card');
  });

  it('offers a credential for a step the proposal leaves needing one, with no id or value in the event', async () => {
    const events = await run(
      'authenticate the status call',
      [
        { toolCalls: [{ id: 'c1', name: 'propose_changes', input: { summary: 'Header token', ops: [{ op: 'setParameters', node: 'Open status incident', parameters: { authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' } }] } }] },
        { text: 'The card adds header auth; pick which credential it uses.' },
      ],
      { selectedNodeId: 'h' },
    );
    const offers = events.filter((e) => e.type === 'credential');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ type: 'credential', node: 'Open status incident', nodeId: 'h', credentialTypes: ['httpHeaderAuth'] });
    expect(JSON.stringify(offers[0])).not.toMatch(/"id"|value|secret|token/i);
  });

  it('offers a credential for a step whose run failed with a 401 when nothing is proposed', async () => {
    const workflow = flow();
    workflow.nodes[1].parameters = { ...workflow.nodes[1].parameters, authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth' };
    const runs: Record<string, RunDigest> = { h: { status: 'error', durationMs: 20, error: { message: 'Request failed with status 401 Unauthorized' }, inputs: [], outputs: [] } };
    const events = await run('this HTTP step fails with 401, fix it', [{ text: 'The status page wants a token.' }], { workflow, runs, selectedNodeId: 'h' });
    const offers = events.filter((e) => e.type === 'credential');
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ node: 'Open status incident', credentialTypes: ['httpHeaderAuth'] });
  });
});
