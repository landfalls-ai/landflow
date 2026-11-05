import { describe, expect, it } from 'vitest';
import { agentLayers, layerScore } from '@/lib/shared/agent-layers';
import { normalizeConfig } from '@/lib/server/agents/store';

const state = (layers: ReturnType<typeof agentLayers>, id: string) => layers.find((l) => l.id === id)?.state;

describe('the layer checklist', () => {
  it('shows an empty agent as mostly to do, with traces always on', () => {
    const layers = agentLayers(normalizeConfig({ name: 'Blank' }), { evalCases: 0 });
    expect(layers.map((l) => l.id)).toEqual(['prompt', 'knowledge', 'tools', 'access', 'guardrails', 'router', 'cache', 'evals', 'traces']);
    expect(state(layers, 'prompt')).toBe('todo');
    expect(state(layers, 'access')).toBe('na');
    expect(state(layers, 'traces')).toBe('done');
    expect(layerScore(layers)).toEqual({ done: 1, total: 8 });
  });

  it('marks each layer done from the settings that switch it on', () => {
    const config = normalizeConfig({
      name: 'Support',
      instructions: 'Help people.',
      model: { provider: 'anthropic', model: 'claude-sonnet-5-5' },
      tools: [{ id: 'k1', type: 'knowledge' }, { id: 't1', type: 'node' }] as never,
      access: { rules: [{ id: 'r1', tool: '*', who: { role: 'member' }, effect: 'ask' }] },
      guardrails: { input: { enabled: true } } as never,
      router: { mode: 'auto', cheapModel: { provider: 'ollama', model: 'small-1' }, maxChars: 400, allowTools: false },
    });
    const layers = agentLayers(config, { evalCases: 3 });
    for (const id of ['prompt', 'knowledge', 'tools', 'access', 'router', 'evals', 'traces']) expect(state(layers, id), id).toBe('done');
    // The response cache doesn't apply to an agent with tools, and the detail says so.
    expect(state(layers, 'cache')).toBe('na');
    expect(layers.find((l) => l.id === 'cache')?.detail).toMatch(/skips agents with tools.*prompt cache is on/);
  });

  it('offers the cache to an agent that can use it, and counts it once switched on', () => {
    const plain = normalizeConfig({ name: 'FAQ', instructions: 'Answer.', model: { provider: 'ollama', model: 'm' } });
    expect(state(agentLayers(plain, { evalCases: 0 }), 'cache')).toBe('todo');
    const cached = normalizeConfig({ ...plain, cache: { enabled: true, ttlSeconds: 600 } });
    expect(state(agentLayers(cached, { evalCases: 0 }), 'cache')).toBe('done');
  });

  it('points each missing layer at where it is set up', () => {
    const layers = agentLayers(normalizeConfig({ name: 'Blank' }), { evalCases: 0 });
    expect(layers.find((l) => l.id === 'router')?.fix).toEqual({ tab: 'abilities', section: 'section-router' });
    expect(layers.find((l) => l.id === 'guardrails')?.fix).toEqual({ tab: 'safety', section: 'section-guardrails' });
    expect(layers.find((l) => l.id === 'evals')?.fix.tab).toBe('evaluations');
  });
});
