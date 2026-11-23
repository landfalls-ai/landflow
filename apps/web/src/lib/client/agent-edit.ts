/**
 * AG16 (wave ag4): editing an agent through its bubbles on the canvas. A bubble edit changes the saved agent's DRAFT (never the
 * flow, never a publish): read the draft, change it, put it back with `saveChange` (PUT, then the smoke test) and tell every
 * surface with `announceSaved`, so the agent's page, Spotlight's cards and every canvas that runs the agent redraw. The edit goes
 * live only after Publish (the bubble's chip runs the gate: lib/client/agent-change.ts `publishChange`, never `skipEval`).
 * No store and no server import.
 */
import { nanoid } from 'nanoid';
import { api } from '@/lib/client/api';
import { announceSaved, readDraft, saveChange } from '@/lib/client/agent-change';
import type { AgentSmoke } from '@/lib/shared/agent-card';

type Draft = Record<string, unknown>;
type Tool = Record<string, unknown> & { id: string };

/** What a sample message for the smoke test says: the test only needs the agent to answer once. */
export const SMOKE_SAMPLE = 'Hello, can you help?';

/** The draft's own settings, for the PUT: what the server stamps on it (times, versions, the kagent deployment) is not sent back. */
const settingsOf = ({ id: _i, updatedAt: _u, createdAt: _c, published: _p, history: _h, kagent: _k, ...rest }: Draft): Draft => rest;

const toolsOf = (draft: Draft): Tool[] => (Array.isArray(draft.tools) ? (draft.tools as Tool[]) : []);

/** Read the draft, change it, save it (the smoke test runs), announce it. The flow is not touched. */
async function edit(agentId: string, change: (draft: Draft) => Draft): Promise<{ smoke: AgentSmoke; draft: Draft }> {
  const draft = await readDraft(agentId);
  if (!draft) throw new Error('The agent could not be read');
  const next = settingsOf(change(draft));
  const smoke = await saveChange(agentId, next, SMOKE_SAMPLE);
  announceSaved(agentId);
  return { smoke, draft: next };
}

/** What can be added to an agent: a tool (node, knowledge base, workflow, sub-agent), by its config; the id is made when it has none. */
export type AgentAddition = { tool: Record<string, unknown> };

/** Add a tool or a knowledge base to the agent's draft. A tool that needs a credential is added without one (its bubble says so). */
export function addToAgent(agentId: string, addition: AgentAddition) {
  const tool = { ...addition.tool, id: typeof addition.tool.id === 'string' && addition.tool.id ? addition.tool.id : `tool_${nanoid(8)}` } as Tool;
  return edit(agentId, (draft) => ({ ...draft, tools: [...toolsOf(draft), tool] }));
}

/** Remove the tool (or knowledge base) with this id from the agent's draft. */
export function removeFromAgent(agentId: string, toolId: string) {
  return edit(agentId, (draft) => ({ ...draft, tools: toolsOf(draft).filter((t) => t.id !== toolId) }));
}

/** Replace one tool of the draft (the dialog's result). */
export function changeAgentTool(agentId: string, tool: Record<string, unknown> & { id: string }) {
  return edit(agentId, (draft) => ({ ...draft, tools: toolsOf(draft).map((t) => (t.id === tool.id ? tool : t)) }));
}

/** Set the agent's model, keeping its provider's credential and server when the provider stays the same. */
export function setAgentModel(agentId: string, model: { provider: string; model: string }) {
  return edit(agentId, (draft) => {
    const before = (draft.model ?? {}) as { provider?: string; credential?: unknown; baseUrl?: unknown; temperature?: unknown };
    const same = before.provider === model.provider;
    return { ...draft, model: { provider: model.provider, model: model.model, ...(same && before.credential ? { credential: before.credential } : {}), ...(same && before.baseUrl ? { baseUrl: before.baseUrl } : {}), ...(same && before.temperature !== undefined ? { temperature: before.temperature } : {}) } };
  });
}

/** Memory: this conversation only, or across sessions. */
export function setAgentMemory(agentId: string, crossSession: boolean) {
  return edit(agentId, (draft) => ({ ...draft, memory: { crossSession } }));
}

/** The tool a bubble stands for: `tool:<id>` → `<id>`. */
export const toolIdOfBubble = (bubbleId: string): string | undefined => (bubbleId.startsWith('tool:') ? bubbleId.slice(5) : undefined);

/** One model a bubble can switch the agent to. */
export interface ModelChoice {
  provider: string;
  model: string;
  label: string;
  description?: string;
}

/** The models an agent can run on: the providers it can reach without a credential picked here (Anthropic), then its own provider's. */
export async function loadModelChoices(current?: { provider?: string }): Promise<ModelChoice[]> {
  const providers = [...new Set(['anthropic', ...(current?.provider ? [current.provider] : [])])];
  const lists = await Promise.all(
    providers.map((provider) =>
      api<{ options: Array<{ model: string; label: string; description?: string }> }>(`/api/agents/models?provider=${provider}`, { background: true }).then(
        (r) => (r.options ?? []).map((o) => ({ provider, ...o })),
        () => [] as ModelChoice[],
      ),
    ),
  );
  return lists.flat();
}

/** "Knowledge from a folder…": a new keyword-search knowledge base in the draft (no embeddings model, no key), then the folder indexed into it. */
export async function addKnowledgeFolder(agentId: string, folder: string): Promise<{ smoke: AgentSmoke; documents: number; failed: number; collection: string; embedded: number; reused: number; removed: number }> {
  const clean = folder.trim().replace(/\/+$/, '');
  const base = clean.split('/').filter(Boolean).at(-1) ?? clean;
  const collection = base.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'documents';
  const id = `tool_${nanoid(8)}`;
  const tool = {
    id,
    type: 'knowledge',
    name: `search_${collection.replace(/-/g, '_')}`,
    description: `Search the ${base} documents for passages that help answer a question. Use it before answering questions about them.`,
    store: 'sqlite',
    collection,
    embeddings: { provider: 'none', model: 'bm25' },
    topK: 4,
    searchMode: 'keyword',
  };
  const { smoke } = await addToAgent(agentId, { tool });
  const indexed = await api<{ documents: number; embedded?: number; reused?: number; removed?: number; failed?: unknown[] }>(`/api/agents/${encodeURIComponent(agentId)}/knowledge/${id}/folder`, { method: 'POST', json: { folder: clean } });
  announceSaved(agentId);
  return { smoke, documents: indexed.documents, failed: indexed.failed?.length ?? 0, collection, embedded: indexed.embedded ?? 0, reused: indexed.reused ?? 0, removed: indexed.removed ?? 0 };
}

/** The knowledge bases (vector stores) other agents the caller can read already have, that this agent does not: each as the tool config to copy. */
export async function loadKnowledgeBases(agentId: string): Promise<Array<Record<string, unknown>>> {
  const { agents } = await api<{ agents: Array<{ id: string; tools: number }> }>('/api/agents', { background: true }).catch(() => ({ agents: [] }));
  const [own, ...drafts] = await Promise.all([readDraft(agentId), ...agents.filter((a) => a.tools > 0 && a.id !== agentId).slice(0, 30).map((a) => readDraft(a.id))]);
  const key = (t: Record<string, unknown>) => `${t.store}|${t.collection}`;
  const have = new Set(toolsOf(own ?? {}).filter((t) => t.type === 'knowledge' && !t.nodeType).map(key));
  const out = new Map<string, Record<string, unknown>>();
  for (const draft of drafts) for (const t of toolsOf(draft ?? {})) if (t.type === 'knowledge' && !t.nodeType && !have.has(key(t)) && !out.has(key(t))) out.set(key(t), t);
  return [...out.values()];
}
