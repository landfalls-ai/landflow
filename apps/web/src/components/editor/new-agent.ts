'use client';
/**
 * Spotlight's `newAgent` (docs/assistant.md#agents-and-teams): when no published agent fits a step, it proposes a
 * dedicated one. Applying the change adds the Run an Agent node; this has the Agent architect design the agent (a local
 * model, the tools it needs, a knowledge base when it works from documents, POST /api/agents/design) and points the node
 * at it. In autonomous mode (./autonomous.ts) the agent is published, so the flow can run it while it is tested; otherwise
 * it stays a draft for a person to check and publish. A test run waits for the agents being designed (`agentsSettled`).
 */
import { api } from '@/lib/client/api';
import type { NewAgentSpec } from '@/lib/shared/assistant-ops';
import { useAssistant, type AgentProgress } from './assistant';
import { useEditor } from './store';

/** Where the agent's step sits, for the architect's request. */
export interface AgentPlace {
  workflow?: string;
  after?: string;
  before?: string;
}

interface Designed {
  agent: { id: string; name: string; model?: { provider: string; model: string }; tools: Array<{ type: string }> };
  needs: Array<{ text: string }>;
  missing: Array<{ capability: string }>;
  designed: boolean;
}

const inFlight = new Set<Promise<void>>();

/** Resolves once every agent being designed is saved (or failed): a test run before that would find no agent. */
export async function agentsSettled(): Promise<void> {
  while (inFlight.size) await Promise.allSettled([...inFlight]);
}

const toolCount = (designed: Designed['agent']) => {
  const knowledge = designed.tools.filter((t) => t.type === 'knowledge').length;
  const others = designed.tools.length - knowledge;
  return [others && `${others} tool${others === 1 ? '' : 's'}`, knowledge && `${knowledge} knowledge base${knowledge === 1 ? '' : 's'}`].filter(Boolean).join(' and ');
};

export function saveAgentFor(nodeId: string, spec: NewAgentSpec, place: AgentPlace = {}, options: { publish?: boolean } = {}): Promise<void> {
  // A row of the Spotlight panel's timeline: designing, then what the agent runs on and what is left to do.
  const progress = (patch: Partial<AgentProgress>) => useAssistant.getState().setAgent(nodeId, { name: spec.name, ...patch });
  const task = (async () => {
    progress({ state: 'designing' });
    try {
      const { agent, needs, missing, designed } = await api<Designed>('/api/agents/design', { method: 'POST', json: { ...spec, ...place } });
      const node = useEditor.getState().nodes.find((n) => n.id === nodeId)?.data.wf;
      if (node) useEditor.getState().updateNode(nodeId, { parameters: { ...node.parameters, agentId: agent.id } });
      let published = false;
      if (options.publish && agent.model) {
        published = await api(`/api/agents/${agent.id}/publish`, { method: 'POST' }).then(
          () => true,
          () => false,
        );
      }
      const has = toolCount(agent);
      const left = [...needs.map((n) => n.text), ...missing.map((m) => `not available here: ${m.capability}`)];
      const summary = [
        agent.model ? `${agent.model.provider}/${agent.model.model}` : 'no model yet',
        has,
        designed ? '' : 'only its instructions (the architect proposed nothing)',
        published ? '' : 'publish it before the flow runs',
        left.length ? `still to do: ${left.slice(0, 2).join('; ')}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      progress({ state: published ? 'published' : 'draft', agentId: agent.id, summary });
    } catch (error) {
      progress({ state: 'failed', summary: `${(error as Error).message} The Run an Agent node has no agent yet: undo, or pick one.` });
    }
  })();
  inFlight.add(task);
  void task.finally(() => inFlight.delete(task));
  return task;
}
