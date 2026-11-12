/**
 * What an agent the Agent architect designs can run on and search (docs/agents.md#agent-architect): the chat models this
 * host can use, local ones first and the one Spotlight itself runs on before the rest, the knowledge bases agents already
 * have, and the embeddings model a new knowledge base gets. Read per request: Ollama's models change as they are pulled.
 */
import type { AgentModel, KnowledgeBaseToolConfig } from '@/lib/shared/agents';
import { agentStore } from '../agents/store';
import { modelOptions, OLLAMA_URL } from '../agents/models';
import { canResource, type Actor } from '../projects';
import { DEFAULT_ASSISTANT_MODEL } from './model';

export interface ModelChoice extends AgentModel {
  /** "local", and whether it calls tools, for the architect to choose by. */
  note: string;
}

export interface AgentResources {
  /** The chat models an agent can use, best first: local (Ollama) ones that call tools, Spotlight's own model first. */
  models: ModelChoice[];
  /** Knowledge bases other agents search, one per store and collection. */
  knowledge: Array<Omit<KnowledgeBaseToolConfig, 'id'> & { usedBy: string[] }>;
  /** The embeddings a new knowledge base gets, from a local embeddings model; undefined when none is pulled. */
  embeddings?: KnowledgeBaseToolConfig['embeddings'];
}

/** Embeddings models in the order they are preferred, with the query prefix each expects. */
const EMBEDDINGS: Array<{ match: RegExp; queryPrefix?: string }> = [{ match: /^nomic-embed-text/, queryPrefix: 'search_query: ' }, { match: /^mxbai-embed-large/ }, { match: /embed/ }];

async function ollamaTags(): Promise<string[]> {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return [];
    return ((await response.json()) as { models: Array<{ name: string }> }).models.map((m) => m.name);
  } catch {
    return [];
  }
}

export async function agentResources(actor: Actor): Promise<AgentResources> {
  const local = await modelOptions('ollama', {}).catch(() => []);
  const own = DEFAULT_ASSISTANT_MODEL.includes('/') ? undefined : DEFAULT_ASSISTANT_MODEL;
  const rank = (m: { model: string; description?: string }) => (m.model === own ? 0 : m.description?.includes('tools ✓') ? 1 : m.description?.includes('no tool support') ? 3 : 2);
  const models: ModelChoice[] = [...local]
    .sort((a, b) => rank(a) - rank(b))
    .map((m) => ({ provider: 'ollama' as const, model: m.model, note: ['local', m.description].filter(Boolean).join(', ') }));
  if (process.env.ANTHROPIC_API_KEY) {
    const [best] = await modelOptions('anthropic', {}).catch(() => []);
    if (best) models.push({ provider: 'anthropic', model: best.model, note: 'Anthropic API, not local' });
  }

  const knowledge = new Map<string, AgentResources['knowledge'][number]>();
  for (const agent of agentStore.list()) {
    if (!canResource(actor, 'agent', agent.id, 'read')) continue;
    for (const tool of agent.tools) {
      if (tool.type !== 'knowledge') continue;
      const key = `${tool.store}:${tool.collection}`;
      const { id: _id, ...base } = tool;
      const seen = knowledge.get(key);
      if (seen) seen.usedBy.push(agent.name);
      else knowledge.set(key, { ...base, usedBy: [agent.name] });
    }
  }

  const tags = await ollamaTags();
  const pick = EMBEDDINGS.map((e) => ({ e, name: tags.find((t) => e.match.test(t)) })).find((x) => x.name);
  const embeddings = pick ? { provider: 'ollama' as const, model: pick.name!, ...(pick.e.queryPrefix && { queryPrefix: pick.e.queryPrefix }) } : undefined;
  return { models, knowledge: [...knowledge.values()], ...(embeddings && { embeddings }) };
}

/** A model the architect wrote ("ollama/qwen3-coder:30b", or just its name) as one of `models`; else the first. */
export function chooseModel(written: unknown, models: readonly ModelChoice[]): AgentModel | undefined {
  const text = typeof written === 'string' ? written.trim() : written && typeof written === 'object' ? String((written as { model?: unknown }).model ?? '') : '';
  const name = text.replace(/^(ollama|anthropic|openai)\//, '');
  const found = (name && models.find((m) => m.model === name)) || models[0];
  return found ? { provider: found.provider, model: found.model } : undefined;
}
