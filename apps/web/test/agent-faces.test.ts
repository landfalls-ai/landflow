/** Whose face a run's actor wears in Run Trace (components/agents/faces.ts `actorAgent`). */
import { describe, expect, it } from 'vitest';
import { actorAgent } from '@/components/agents/faces';
import type { AgentSummary } from '@/lib/shared/agents';

const agents = [
  { id: 'ag_lead', name: 'Tech Lead' },
  { id: 'ag_plan', name: 'Planner', kagent: 'landflow-planner' },
] as AgentSummary[];

describe('actor faces', () => {
  it('finds an agent by id, by its kagent card name and by name', () => {
    expect(actorAgent({ id: 'agent:ag_plan', name: 'Anything', type: 'agent' }, agents)?.id).toBe('ag_plan');
    // kagent names the card with underscores.
    expect(actorAgent({ id: 'remote:landflow_planner', name: 'landflow_planner', type: 'agent' }, agents)?.id).toBe('ag_plan');
    expect(actorAgent({ id: 'node:lead', name: 'Tech Lead', type: 'agent' }, agents)?.id).toBe('ag_lead');
  });

  it('leaves people, models and unknown agents with initials', () => {
    expect(actorAgent({ id: 'human:u1', name: 'Tech Lead', type: 'human' }, agents)).toBeUndefined();
    expect(actorAgent({ id: 'remote:other', name: 'Someone else', type: 'agent' }, agents)).toBeUndefined();
    expect(actorAgent({ id: 'agent:ag_plan', name: 'Planner', type: 'agent' }, undefined)).toBeUndefined();
  });
});
