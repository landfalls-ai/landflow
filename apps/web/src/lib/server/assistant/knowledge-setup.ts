/**
 * AG13: the knowledge an agent Spotlight designs answers from (docs/assistant.md "Agents from Spotlight", docs/agents.md
 * "Knowledge bases"). The design route runs `withKnowledgeSetup` on the architect's result: a folder the ask named becomes
 * the new knowledge base's source (Create indexes it); an ask with no folder gets a question, never an invented source;
 * with no embeddings model the base is searched by keywords (Landflow's own BM25, no call, no key).
 */
import { toToolName } from '@landflow/engine';
import { nanoid } from 'nanoid';
import type { AgentKnowledgeSetup } from '@/lib/shared/agent-card';
import { isNodeKnowledge, type AgentConfig, type VectorKnowledgeBaseConfig } from '@/lib/shared/agents';
import { folderFiles } from '../agents/knowledge';
import type { AgentResources } from './agent-resources';

/** Keyword search: Landflow's BM25 over the stored passages; no embeddings model, no key. */
export const KEYWORD_EMBEDDINGS: VectorKnowledgeBaseConfig['embeddings'] = { provider: 'none', model: 'bm25' };

/** At most this many files are listed on the card (the count says how many there are). */
const LISTED = 50;

/** The knowledge base's embeddings in words: `keyword search (BM25, built in)` or `provider/model`. */
export function searchWords(embeddings: VectorKnowledgeBaseConfig['embeddings']): string {
  return embeddings.provider === 'none' ? 'keyword search (BM25, built in)' : `${embeddings.provider}/${embeddings.model}`;
}

/** The folder as the card lists it: its indexable files (never read), or why it cannot be used. */
export async function folderSetup(folder: string): Promise<{ folder: string; files: string[]; fileCount: number } | { problem: string }> {
  try {
    const { files } = await folderFiles(folder);
    if (!files.length) return { problem: `${folder} holds no file Landflow can read (Markdown, text, PDF, DOCX, HTML, CSV, JSON)` };
    return { folder, files: files.slice(0, LISTED), fileCount: files.length };
  } catch (caught) {
    const message = (caught as Error).message;
    if (/outside the files directory/i.test(message)) return { problem: `${folder} is not in the files directory` };
    return { problem: /^No folder named/i.test(message) ? `no folder named ${folder} in the files directory` : `${folder} cannot be read` };
  }
}

type Need = { tool: string; kind: 'parameter' | 'credential' | string; text: string };
type Knowledge = Omit<AgentKnowledgeSetup, 'state' | 'indexed' | 'error'>;

const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const ADD_DOCS = /add documents/i;
const ruleFor = (tool: { name?: string }) => `Answer from what ${toToolName(tool.name ?? 'the knowledge base')} returns, and name the file (its \`source\`) each answer comes from; if it finds nothing, say so.`;

/**
 * The post-pass of the design route. `folder` is what the ask named, `knowledge` what it answers from in words;
 * `spotlight` is Spotlight's design (the Agent architect dialog keeps today's behaviour: an empty new knowledge base and a
 * need to add documents); `revise` is a change to a pending card or an agent. Returns the changed config and needs, and the
 * preview's `knowledge` (none when the agent has no knowledge base and none was asked for).
 */
export async function withKnowledgeSetup<N extends Need>(
  draft: { config: Partial<AgentConfig>; needs: N[] },
  options: { folder?: string; knowledge?: string; spotlight: boolean; revise?: boolean; resources?: Pick<AgentResources, 'knowledge' | 'embeddings'> },
): Promise<{ config: Partial<AgentConfig>; needs: N[]; knowledge?: Knowledge }> {
  const { folder, resources } = options;
  const tools = [...(draft.config.tools ?? [])];
  let needs = [...draft.needs];
  const isNew = (t: VectorKnowledgeBaseConfig) => !resources?.knowledge.some((k) => k.collection === t.collection && k.store === t.store);
  const vectorIndex = () => tools.findIndex((t) => t.type === 'knowledge' && !isNodeKnowledge(t));
  const withoutAddDocs = (label: string) => needs.filter((n) => !(n.tool === label && ADD_DOCS.test(n.text)));
  const embeddings = resources?.embeddings ?? KEYWORD_EMBEDDINGS;

  if (folder) {
    const listed = await folderSetup(folder);
    let index = vectorIndex();
    if ('problem' in listed) {
      // A folder that cannot be used: say why and what to do; the agent keeps what the design gave it, nothing is indexed.
      const tool = index >= 0 ? (tools[index] as VectorKnowledgeBaseConfig) : undefined;
      if (tool && isNew(tool)) needs = withoutAddDocs(tool.name);
      needs.push({ tool: 'knowledge', kind: 'parameter', text: `${listed.problem}: put the files under the files directory, in a folder, and name it` } as N);
      return { config: { ...draft.config, tools }, needs, knowledge: { collection: tool?.collection ?? slug(folder), existing: Boolean(tool && !isNew(tool)), folder, problem: listed.problem } };
    }
    if (index < 0) {
      // The design left the knowledge base out: the folder is the source, so the agent gets one for it.
      tools.push({ id: `tl_${nanoid(8)}`, type: 'knowledge', name: `search_${slug(folder)}`.slice(0, 64), description: `Search the documents of ${folder}`, store: 'sqlite', collection: slug(folder), embeddings } as VectorKnowledgeBaseConfig);
      index = tools.length - 1;
    }
    const base = tools[index] as VectorKnowledgeBaseConfig;
    let tool = base;
    if (isNew(base)) {
      const keyword = embeddings.provider === 'none';
      tool = { ...base, collection: slug(folder), store: 'sqlite', embeddings, indexedFrom: folder, ...(keyword && { searchMode: 'keyword' as const }) };
      needs = withoutAddDocs(base.name);
    }
    const existing = !isNew(base);
    const rule = ruleFor(tool);
    tools[index] = tool;
    const instructions = draft.config.instructions ?? '';
    const config = { ...draft.config, tools, ...(!instructions.includes('name the file') && { instructions: `${instructions}${instructions ? '\n\n' : ''}${rule}` }) };
    return { config, needs, knowledge: { collection: tool.collection, existing, folder, files: listed.files, fileCount: listed.fileCount, search: tool.embeddings.provider === 'none' ? 'keyword' : 'vector', embeddings: searchWords(tool.embeddings) } };
  }

  const index = vectorIndex();
  if (index < 0) return { config: { ...draft.config, tools }, needs };
  const tool = tools[index] as VectorKnowledgeBaseConfig;
  if (!isNew(tool)) return { config: { ...draft.config, tools }, needs, knowledge: { collection: tool.collection, existing: true, search: tool.embeddings.provider === 'none' ? 'keyword' : 'vector', embeddings: searchWords(tool.embeddings) } };
  if (options.spotlight && !options.revise) {
    // Asked for knowledge, named no source and none exists that fits: ask, never invent (nothing is indexed).
    tools.splice(index, 1);
    needs = withoutAddDocs(tool.name);
    needs.push({ tool: 'knowledge', kind: 'parameter', text: 'Which folder does it answer from? Put the documents in a folder under the files directory and name it ("… from the folder runbooks").' } as N);
    return { config: { ...draft.config, tools }, needs, knowledge: { collection: '', existing: false } };
  }
  return { config: { ...draft.config, tools }, needs };
}
