/**
 * What an agent the Agent architect designs can run on and search (docs/agents.md#agent-architect): the chat models this
 * host can use, local ones first and the one Spotlight itself runs on before the rest, the knowledge bases agents already
 * have, and the embeddings model a new knowledge base gets. Read per request: Ollama's models change as they are pulled.
 */
import type { AgentModel, VectorKnowledgeBaseConfig as KnowledgeBaseToolConfig } from '@/lib/shared/agents';
import { isNodeKnowledge } from '@/lib/shared/agents';
import { agentStore } from '../agents/store';
import { modelOptions } from '../agents/models';
import { ollamaUrl } from '../config';
import { canResource, type Actor } from '../projects';
import { creationProject } from '../projects/access'; // C21:
import { collectionKeyOf } from '../agents/knowledge'; // C21:
import { collectionAccess } from '../rag/collection-access'; // C21:
import type { CollectionAccess } from '../../shared/collections'; // C21:
import { homeProjectId } from '../projects/store';
import { KEYWORD_EMBEDDINGS } from './knowledge-setup';
import { DEFAULT_ASSISTANT_MODEL } from './model';

export interface ModelChoice extends AgentModel {
  /** "local", and whether it calls tools, for the architect to choose by. */
  note: string;
}

export interface AgentResources {
  /** The chat models an agent can use, best first: local (Ollama) ones that call tools, Spotlight's own model first. */
  models: ModelChoice[];
  /** Knowledge bases other agents search, one per store and collection. */
  knowledge: Array<Omit<KnowledgeBaseToolConfig, 'id'> & { usedBy: string[]; /** C21: set when another project owns it and shared it with the asking project. */ access?: 'read' | 'write' }>;
  /** The embeddings a new knowledge base gets: a local embeddings model, else keyword search (AG13: provider `none`). */
  embeddings?: KnowledgeBaseToolConfig['embeddings'];
}

/** Embeddings models in the order they are preferred, with the query prefix each expects. */
const EMBEDDINGS: Array<{ match: RegExp; queryPrefix?: string }> = [{ match: /^nomic-embed-text/, queryPrefix: 'search_query: ' }, { match: /^mxbai-embed-large/ }, { match: /embed/ }];

async function ollamaTags(): Promise<string[]> {
  try {
    const response = await fetch(`${ollamaUrl()}/api/tags`, { signal: AbortSignal.timeout(3_000) });
    if (!response.ok) return [];
    return ((await response.json()) as { models: Array<{ name: string }> }).models.map((m) => m.name);
  } catch {
    return [];
  }
}

/** AG02: the host's builder model (`LANDFLOW_BUILDER_MODEL`, read per call): a bare Ollama name or `provider/model`. */
export const builderModel = () => process.env.LANDFLOW_BUILDER_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;

/** AG02: a model name as an agent's model: `anthropic/x` and `ollama/x` as named, a bare name is Ollama's; another provider (`litellm/`, `openai/`) has none an agent can use without a credential. */
export function agentModelOf(name: string | undefined): AgentModel | undefined {
  const text = name?.trim();
  if (!text) return undefined;
  const prefix = /^([a-z]+)\//.exec(text)?.[1];
  if (!prefix) return { provider: 'ollama', model: text };
  if (prefix === 'anthropic' || prefix === 'ollama') return { provider: prefix, model: text.slice(prefix.length + 1) };
  return undefined;
}

export async function agentResources(actor: Actor, projectId?: string): Promise<AgentResources> {
  const local = await modelOptions('ollama', {}).catch(() => []);
  const builder = agentModelOf(builderModel()); // AG02: the host's own model leads, whichever provider it is
  const own = builder?.provider === 'ollama' ? builder.model : undefined;
  const rank = (m: { model: string; description?: string }) => (m.model === own ? 0 : m.description?.includes('tools ✓') ? 1 : m.description?.includes('no tool support') ? 3 : 2);
  const models: ModelChoice[] = [...local]
    .sort((a, b) => rank(a) - rank(b))
    .map((m) => ({ provider: 'ollama' as const, model: m.model, note: ['local', m.description].filter(Boolean).join(', ') }));
  if (process.env.ANTHROPIC_API_KEY) {
    // AG02: the builder model first when it is Anthropic's, then the provider's other models (never one ahead of it).
    const all = await modelOptions('anthropic', {}).catch(() => []);
    const choices = all.map((m): ModelChoice => ({ provider: 'anthropic', model: m.model, note: 'Anthropic API, not local' }));
    if (builder?.provider === 'anthropic') {
      const first = choices.find((c) => c.model === builder.model) ?? { provider: 'anthropic' as const, model: builder.model, note: 'Anthropic API, not local' };
      models.unshift(first, ...choices.filter((c) => c !== first));
    } else models.push(...choices);
  }

  const knowledge = new Map<string, AgentResources['knowledge'][number]>();
  // C21: only collections the asking project may read (FR-5, AS-8); the session's project, else the actor's own.
  let asProject: string | undefined;
  try {
    asProject = projectId ?? creationProject(actor);
  } catch {
    asProject = undefined;
  }
  for (const agent of agentStore.list()) {
    const mine = canResource(actor, 'agent', agent.id, 'read') && (!projectId || homeProjectId('agent', agent.id) === projectId);
    for (const tool of agent.tools) {
      // A plugin's knowledge base (Clickland) has no collection to share: only vector stores are offered.
      if (tool.type !== 'knowledge' || isNodeKnowledge(tool)) continue;
      const key = `${tool.store}:${tool.collection}`;
      let access: CollectionAccess;
      try {
        access = collectionAccess(collectionKeyOf(tool), asProject);
      } catch {
        continue; // a base whose store can't be reached is not offered
      }
      if (access === 'none') continue;
      const { id: _id, ...base } = tool;
      if (mine) {
        const seen = knowledge.get(key);
        if (seen) seen.usedBy.push(agent.name);
        else knowledge.set(key, { ...base, usedBy: [agent.name] });
      } else if ((access === 'read' || access === 'write') && tool.store !== 'pgvector' && !knowledge.has(key)) {
        // C21: a collection another project shared with this one is offered as it is, without the names of that project's agents
        // (a pgvector one carries its owner's credential, so it is not offered: name it by hand with a credential of your own).
        knowledge.set(key, { ...base, usedBy: [], access });
      }
    }
  }

  const tags = await ollamaTags();
  const pick = EMBEDDINGS.map((e) => ({ e, name: tags.find((t) => e.match.test(t)) })).find((x) => x.name);
  // AG13: with no embeddings model a new knowledge base is searched by keywords (built in), never dropped for want of a model
  const embeddings: KnowledgeBaseToolConfig['embeddings'] = pick ? { provider: 'ollama' as const, model: pick.name!, ...(pick.e.queryPrefix && { queryPrefix: pick.e.queryPrefix }) } : KEYWORD_EMBEDDINGS;
  return { models, knowledge: [...knowledge.values()], embeddings };
}

/** A model the architect wrote ("ollama/qwen3-coder:30b", or just its name) as one of `models`; else the first. */
export function chooseModel(written: unknown, models: readonly ModelChoice[]): AgentModel | undefined {
  const text = typeof written === 'string' ? written.trim() : written && typeof written === 'object' ? String((written as { model?: unknown }).model ?? '') : '';
  const name = text.replace(/^(ollama|anthropic|openai)\//, '');
  const found = (name && models.find((m) => m.model === name)) || models[0];
  return found ? { provider: found.provider, model: found.model } : undefined;
}
