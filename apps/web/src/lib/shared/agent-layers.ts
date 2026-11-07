/**
 * The layers around an agent's model (docs/agents.md "Layers"): which of them this agent has, read from its config. Nothing here
 * needs a new component; each layer points at the setting that switches it on.
 */
import type { AgentConfig } from './agents';
import { hasPrompt } from './persona';

export type LayerState = 'done' | 'todo' | 'na';

export interface Layer {
  id: 'prompt' | 'knowledge' | 'tools' | 'access' | 'guardrails' | 'router' | 'cache' | 'evals' | 'traces';
  label: string;
  state: LayerState;
  /** One line: what is set, or why it matters. */
  detail: string;
  /** The builder tab and the element to scroll to when fixing it. */
  fix: { tab: 'persona' | 'abilities' | 'safety' | 'evaluations'; section?: string };
}

export interface LayerFacts {
  /** Test cases in the agent's eval gate. */
  evalCases: number;
}

/** The layers in the order a request passes through them. */
export function agentLayers(config: AgentConfig, facts: LayerFacts): Layer[] {
  const tools = config.tools;
  const hasTools = tools.length > 0;
  const knowledge = tools.filter((t) => t.type === 'knowledge').length;
  const rules = config.access?.rules.length ?? 0;
  const guarded = Boolean(config.guardrails?.input || config.guardrails?.output || config.guardrails?.toolResult);
  const routed = config.router?.mode === 'auto' && Boolean(config.router.cheapModel?.model);
  const provider = config.model?.provider;
  return [
    { id: 'prompt', label: 'System prompt', state: hasPrompt(config) ? 'done' : 'todo', detail: hasPrompt(config) ? 'A persona or instructions are set.' : 'Describe who the agent is and how it should answer.', fix: { tab: 'persona', section: 'section-persona' } },
    {
      id: 'knowledge',
      label: 'Knowledge (RAG)',
      state: knowledge ? 'done' : 'todo',
      detail: knowledge ? `${knowledge} knowledge base${knowledge === 1 ? '' : 's'} attached.` : 'Attach documents so answers come from your sources rather than the model’s memory.',
      fix: { tab: 'abilities', section: 'section-capabilities' },
    },
    {
      id: 'tools',
      label: 'Tools',
      state: hasTools ? 'done' : 'todo',
      detail: hasTools ? `${tools.length} tool${tools.length === 1 ? '' : 's'} attached.` : 'Let the agent look things up or act, through MCP servers, workflows or nodes.',
      fix: { tab: 'abilities', section: 'section-capabilities' },
    },
    {
      id: 'access',
      label: 'Tool access',
      state: !hasTools ? 'na' : rules ? 'done' : 'todo',
      detail: !hasTools ? 'No tools to restrict.' : rules ? `${rules} rule${rules === 1 ? '' : 's'}.` : 'Every caller may use every tool. Add rules for the tools that change things.',
      fix: { tab: 'abilities', section: 'section-access' },
    },
    { id: 'guardrails', label: 'Guardrails', state: guarded ? 'done' : 'todo', detail: guarded ? 'Checks run on messages in or answers out.' : 'Check for personal data, secrets and prompt injection before and after the model.', fix: { tab: 'safety', section: 'section-guardrails' } },
    {
      id: 'router',
      label: 'Model router',
      state: routed ? 'done' : 'todo',
      detail: routed ? `Easy requests go to ${config.router?.cheapModel?.model}.` : 'Send short, simple requests to a cheaper model.',
      fix: { tab: 'abilities', section: 'section-router' },
    },
    {
      id: 'cache',
      label: 'Cache',
      state: config.cache?.enabled ? 'done' : hasTools || config.memory.crossSession ? 'na' : 'todo',
      detail: config.cache?.enabled
        ? 'Repeated questions are answered from the cache.'
        : hasTools || config.memory.crossSession
          ? `The response cache skips agents with ${hasTools ? 'tools' : 'memory'}.${provider === 'anthropic' ? ' The prompt cache is on.' : ''}`
          : `Answer repeated questions without a model call.${provider === 'anthropic' ? ' The prompt cache is already on.' : ''}`,
      fix: { tab: 'abilities', section: 'section-cache' },
    },
    { id: 'evals', label: 'Evals', state: facts.evalCases > 0 ? 'done' : 'todo', detail: facts.evalCases > 0 ? `${facts.evalCases} test case${facts.evalCases === 1 ? '' : 's'} guard each publish.` : 'Add test questions so a bad edit is caught before it goes live.', fix: { tab: 'evaluations' } },
    { id: 'traces', label: 'Traces', state: 'done', detail: 'Every run is traced in Run Trace and exported over OTLP.', fix: { tab: 'evaluations' } },
  ];
}

/** Done of those that apply. */
export function layerScore(layers: Layer[]): { done: number; total: number } {
  const applicable = layers.filter((l) => l.state !== 'na');
  return { done: applicable.filter((l) => l.state === 'done').length, total: applicable.length };
}
