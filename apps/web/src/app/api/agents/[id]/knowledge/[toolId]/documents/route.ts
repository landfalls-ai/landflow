/**
 * Documents of an agent's knowledge base (the draft's knowledge tool `toolId`).
 * GET — the uploaded documents. POST multipart `file` (one or more) — load, split, embed and store them.
 * DELETE ?documentId= — remove one document's chunks.
 */
import { agentStore } from '@/lib/server/agents/store';
import { addKnowledgeDocument, deleteKnowledgeDocument, listKnowledgeDocuments, MAX_UPLOAD_BYTES } from '@/lib/server/agents/knowledge';
import { FileLoadError } from '@/lib/server/rag/files';
import { error, handler, json } from '@/lib/server/http';
import type { KnowledgeBaseToolConfig } from '@/lib/shared/agents';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; toolId: string }> };

async function knowledgeOf({ params }: Ctx): Promise<KnowledgeBaseToolConfig | Response> {
  const { id, toolId } = await params;
  const agent = agentStore.get(id);
  if (!agent) return error('Agent not found', 404);
  const tool = agent.tools.find((t): t is KnowledgeBaseToolConfig => t.type === 'knowledge' && t.id === toolId);
  return tool ?? error('Knowledge base not found: save the agent first', 404);
}

export const GET = handler(async (_request: Request, ctx: Ctx) => {
  const config = await knowledgeOf(ctx);
  if (config instanceof Response) return config;
  try {
    return json(await listKnowledgeDocuments(config));
  } catch (caught) {
    return error((caught as Error).message, 502);
  }
});

export const POST = handler(async (request: Request, ctx: Ctx) => {
  const config = await knowledgeOf(ctx);
  if (config instanceof Response) return config;
  const form = await request.formData().catch(() => undefined);
  const files = (form?.getAll('file') ?? []).filter((f): f is File => typeof f !== 'string');
  if (!files.length) return error('Send the files as multipart form data in the “file” field');
  const documents = [];
  const failed: Array<{ fileName: string; error: string }> = [];
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      failed.push({ fileName: file.name, error: `Too large (${Math.round(file.size / 1024 / 1024)} MB; the limit is ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
      continue;
    }
    try {
      documents.push(await addKnowledgeDocument(config, { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name, ...(file.type && { mimeType: file.type }) }));
    } catch (caught) {
      failed.push({ fileName: file.name, error: [(caught as Error).message, caught instanceof FileLoadError ? caught.description : undefined].filter(Boolean).join(': ') });
    }
  }
  return json({ documents, failed }, documents.length ? 201 : 400);
});

export const DELETE = handler(async (request: Request, ctx: Ctx) => {
  const config = await knowledgeOf(ctx);
  if (config instanceof Response) return config;
  const documentId = new URL(request.url).searchParams.get('documentId');
  if (!documentId) return error('documentId is required');
  return json({ removed: await deleteKnowledgeDocument(config, documentId) });
});
