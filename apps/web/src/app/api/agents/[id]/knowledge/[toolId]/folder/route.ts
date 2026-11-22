/**
 * AG13: POST { folder } — index a folder of the files directory (LANDFLOW_FILES_DIR) into an agent's knowledge base (the
 * draft's knowledge tool `toolId`): every file the loaders read (Markdown, text, PDF, DOCX, HTML, CSV, JSON; at most 200
 * files, 25 MB each), each chunk's metadata with `source` the file's path relative to the files directory. Indexing a folder
 * again embeds only the chunks whose text changed (C20), replaces each file's chunks in one step and removes the chunks
 * of files that left the folder. Answers 200 `{ documents, chunks, reused, embedded, removed, failed: [{ file, error }] }`;
 * sets the tool's `indexedFrom` and `lastIndex` (the counts, with the time) in the draft. 400 for a folder outside the files directory or missing (or a plugin's knowledge base); 404
 * for an agent or knowledge base the caller cannot update.
 */
import { z } from 'zod';
import { folderFiles, indexFolder } from '@/lib/server/agents/knowledge';
import { agentStore, configOf } from '@/lib/server/agents/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { canResource } from '@/lib/server/projects/access';
import { routeActor } from '@/lib/server/projects/http';
import type { KnowledgeBaseToolConfig } from '@/lib/shared/agents';
import { isNodeKnowledge } from '@/lib/shared/agents';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; toolId: string }> };

const Body = z.object({ folder: z.string().trim().min(1).max(200) });

export const POST = handler(async (request: Request, { params }: Ctx) => {
  const { id, toolId } = await params;
  const agent = agentStore.get(id);
  if (!agent || !canResource(routeActor(), 'agent', id, 'update')) return error('Agent not found', 404);
  const tool = agent.tools.find((t): t is KnowledgeBaseToolConfig => t.type === 'knowledge' && t.id === toolId);
  if (!tool) return error('Knowledge base not found: save the agent first', 404);
  if (isNodeKnowledge(tool)) return error(`${tool.name} is answered by a plugin (${tool.nodeType}): it has no documents to index`, 400);
  const parsed = await parseBody(request, Body);
  if (!parsed.ok) return parsed.response;
  const { folder } = parsed.data;
  try {
    await folderFiles(folder);
  } catch (caught) {
    return error((caught as Error).message, 400);
  }
  let result;
  try {
    result = await indexFolder(tool, folder);
  } catch (caught) {
    return error((caught as Error).message, 502);
  }
  // The draft remembers where its knowledge base was indexed from.
  const tools = agent.tools.map((t) => (t.id === toolId && t.type === 'knowledge' && !isNodeKnowledge(t) ? { ...t, indexedFrom: folder.replace(/\/+$/, ''), lastIndex: { at: new Date().toISOString(), documents: result.documents, embedded: result.embedded, reused: result.reused, removed: result.removed, failed: result.failed.length } } : t));
  agentStore.saveDraft(id, { ...configOf(agent), tools });
  return json(result);
});
