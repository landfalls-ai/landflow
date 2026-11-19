/**
 * NB06: the company's Notion pages as knowledge (docs/features/notion-brain.md#your-companys-pages-as-knowledge). The walk reads
 * the pages under the brain page (or under the root, the link's `knowledgeScope`) that Landflow did not create, keeps each
 * page's Markdown in `notion_knowledge_docs` and its chunks in the vector collection `landflow-notion-<project>` (BM25 always,
 * vectors when the brain's embeddings are on). Ask, the project's agents and MCP read that collection; nothing writes to Notion
 * and nothing calls `/v1/search`.
 *
 * The walk registers itself as the knowledge step of the sync service (`setKnowledgeStep`): once per tick per link, returning at
 * once until 15 minutes passed since its last pass (Sync now forces it).
 */
import { createHash } from 'node:crypto';
import type { Embeddings } from '@landflow/engine';
import type { JsonObject } from '@landflow/protocol';
import { ASK_KNOWLEDGE_LIMIT, type KnowledgeHit } from '../../../shared/brain-wiki';
import { notionKnowledgeCollection } from '../../../shared/notion-brain';
import { NOTION_DATA_NOTE } from './data-note';
import { notionBrainLabel, PROJECT_KNOWLEDGE_TOOL, type NotionBrainKnowledge } from '../../../shared/project-policy';
import type { VectorKnowledgeBaseConfig } from '../../../shared/agents';
import { ollamaUrl } from '../../config';
import { database } from '../../db';
import { notionId, sameId, type NotionClient, type NotionPage } from '../../notion/port';
import { ollamaEmbeddings } from '../../rag/embeddings';
import { recursiveCharacterSplit } from '../../rag/splitters';
import { insertDocuments, searchStore, SqliteVectorStore, type SearchMode } from '../../rag/stores';
import { logger } from '../../telemetry/logger';
import { getProject } from '../../projects/store';
import { getLink, linkById, listActiveLinks, notionBrainEnabled, setCursors, type LinkRow } from './links';
import { itemsOf, linkDatabases, readClient, setKnowledgeStep, type SyncStep } from './sync';

/** Pages are read at most this deep below the start page (the start page's children are depth 1). */
export const MAX_DEPTH = 8;
/** At most this many pages are read, and this many indexed, in one pass (the rest wait for the next). */
export const PASS_PAGES = 200;
/** A page's Markdown is kept to this many characters. */
export const MAX_MARKDOWN_CHARS = 200_000;
/** The walk runs this often (Sync now forces it). */
export const WALK_INTERVAL_MS = 15 * 60_000;

const PROBE_MS = 10_000;
/** What the next pass indexes with: the brain's model when it answers, else keyword vectors (the collection never mixes the two). */
async function usableEmbeddings(): Promise<string> {
  const model = brainEmbeddingsModel();
  if (!model) return 'bm25';
  try {
    await ollamaEmbeddings({ baseUrl: ollamaUrl(), model, queryPrefix: 'search_query: ' }).embedQuery('ping', AbortSignal.timeout(PROBE_MS));
    return model;
  } catch (error) {
    logger.warn('[notion-brain] knowledge walk: the embeddings model did not answer; indexing for keyword search', { model, error: (error as Error).message });
    return 'bm25';
  }
}

const CHUNK = { chunkSize: 1_000, chunkOverlap: 150 };

export interface KnowledgeDocRow {
  link_id: string;
  page_id: string;
  title: string | null;
  url: string | null;
  path: string | null;
  edited_at: string | null;
  hash: string | null;
  markdown: string | null;
  truncated: number;
}

/** What `cursors.knowledge` keeps (the other keys of `cursors` are the pull's). */
interface KnowledgeCursor {
  /** When the last pass started (ISO). */
  at?: string;
  /** The embeddings the collection holds (`bm25` or the model), so a change clears and re-indexes it. */
  embeddings?: string;
  /** Pages still waiting for a read or an index after the cap: the next tick continues at once. */
  pending?: number;
  error?: string;
}

const readCursors = (link: LinkRow): Record<string, unknown> => {
  try {
    const parsed = link.cursors ? (JSON.parse(link.cursors) as unknown) : {};
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};
/** Keeps the other keys of `cursors` (the pull's), read fresh: the pull may have written them since this tick began. */
const writeCursor = (linkId: string, knowledge: KnowledgeCursor) => setCursors(linkId, { ...readCursors(linkById(linkId) ?? ({ cursors: null } as LinkRow)), knowledge });

// ---------------------------------------------------------------------------------------------------- embeddings

/** The brain's embeddings model (`LANDFLOW_BRAIN_EMBEDDINGS`, as `embedFacts` reads it): undefined when it is off. */
export function brainEmbeddingsModel(): string | undefined {
  const model = process.env.LANDFLOW_BRAIN_EMBEDDINGS?.trim();
  return model?.toLowerCase() === 'off' ? undefined : model || 'nomic-embed-text';
}

/** A knowledge tool's embeddings setting for what a collection holds: the model, or keyword search (BM25). */
export const knowledgeEmbeddingsSetting = (model?: string): VectorKnowledgeBaseConfig['embeddings'] =>
  model && model !== 'bm25' ? { provider: 'ollama', model, queryPrefix: 'search_query: ' } : { provider: 'none', model: 'bm25' };

/** The embeddings a link's collection actually holds (`cursors.knowledge.embeddings`): a model name, or undefined for keyword vectors. */
export function heldModel(link: LinkRow): string | undefined {
  const held = ((readCursors(link).knowledge ?? {}) as KnowledgeCursor).embeddings;
  return held && held !== 'bm25' ? held : undefined;
}

const keyword: Embeddings = { provider: 'none', model: 'bm25', embedDocuments: async (texts) => texts.map(() => [0]), embedQuery: async () => [0] };
const embeddingsOf = (model: string | undefined): Embeddings => {
  return model ? ollamaEmbeddings({ baseUrl: ollamaUrl(), model, documentPrefix: 'search_document: ', queryPrefix: 'search_query: ' }) : keyword;
};

// ---------------------------------------------------------------------------------------------------- the docs table

const docsOf = (linkId: string): KnowledgeDocRow[] => database().all<KnowledgeDocRow>('SELECT * FROM notion_knowledge_docs WHERE link_id = ?', linkId);
const saveDoc = (row: KnowledgeDocRow) => database().upsert('notion_knowledge_docs', row as unknown as Record<string, never>);
const dropDoc = (linkId: string, pageId: string) => database().delete('notion_knowledge_docs', { link_id: linkId, page_id: pageId });

const compact = (id: string) => id.replace(/-/g, '').toLowerCase();
const dashed = (id: string) => notionId(id) ?? id.toLowerCase();
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

// ---------------------------------------------------------------------------------------------------- the walk

interface Candidate {
  id: string;
  title: string;
  /** Titles from the start page's child down to this page's parent. */
  path: string[];
  edited: string;
  /** A database row already carries its page. */
  row?: NotionPage;
}

const titleOf = (page: NotionPage): string => {
  const property = Object.values(page.properties).find((p) => p.type === 'title');
  return (property?.title ?? []).map((run) => run.plain_text ?? run.text?.content ?? '').join('').trim() || 'Untitled';
};

/** What Landflow made (never read as knowledge): the brain page's own pages, rows and databases. */
function ownIds(link: LinkRow): Set<string> {
  const ids = new Set<string>();
  const add = (id: string | null | undefined) => id && ids.add(compact(id));
  add(link.log_page_id);
  for (const item of itemsOf(link.id)) add(item.notion_id);
  for (const db of Object.values(linkDatabases(link))) {
    add(db?.databaseId);
    add(db?.dataSourceId);
  }
  return ids;
}

interface Walked {
  candidates: Candidate[];
  /** False when a branch could not be read: nothing is deleted from a partial walk. */
  complete: boolean;
}

/** The pages under the start page, down to MAX_DEPTH, and the rows of the databases that are not the link's own. */
async function walk(client: NotionClient, link: LinkRow): Promise<Walked> {
  const start = link.knowledge_scope === 'root' ? link.root_page_id : link.brain_page_id;
  const out: Walked = { candidates: [], complete: true };
  if (!start) return out;
  const own = ownIds(link);
  const seen = new Set<string>();
  const brain = link.brain_page_id ?? undefined;

  const visit = async (parent: string, path: string[], depth: number): Promise<void> => {
    for await (const block of client.paginate((cursor) => client.children(parent, cursor))) {
      if (block.in_trash) continue;
      if (block.type === 'child_page') {
        const id = block.id;
        if (own.has(compact(id)) || seen.has(compact(id))) continue;
        seen.add(compact(id));
        const title = block.child_page?.title?.trim() || 'Untitled';
        if (sameId(id, brain)) {
          // The brain page is a container (Home is Landflow's own): the people's pages under it are read when the walk starts at the root.
          if (depth < MAX_DEPTH) await visit(id, [...path, title], depth + 1).catch(failed);
          continue;
        }
        out.candidates.push({ id, title, path, edited: block.last_edited_time });
        if (block.has_children && depth < MAX_DEPTH) await visit(id, [...path, title], depth + 1).catch(failed);
      } else if (block.type === 'child_database') {
        if (own.has(compact(block.id)) || seen.has(compact(block.id))) continue;
        seen.add(compact(block.id));
        const title = block.child_database?.title?.trim() || 'Database';
        await rows(block.id, [...path, title]).catch(failed);
      }
    }
  };
  const failed = (error: unknown) => {
    // A branch that cannot be read (unshared since, a failed call) leaves the rest of the walk alone and blocks deletions.
    out.complete = false;
    logger.warn('[notion-brain] knowledge walk: a branch could not be read', { link: link.id, error: (error as Error).message });
  };
  const rows = async (databaseId: string, path: string[]): Promise<void> => {
    const db = await client.database(databaseId);
    if (db.in_trash) return;
    for (const source of db.data_sources) {
      if (own.has(compact(source.id))) continue;
      for await (const row of client.paginate((cursor) => client.queryDataSource(source.id, cursor ? { start_cursor: cursor } : {}))) {
        if (row.in_trash || own.has(compact(row.id)) || seen.has(compact(row.id))) continue;
        seen.add(compact(row.id));
        out.candidates.push({ id: row.id, title: titleOf(row), path, edited: row.last_edited_time, row });
      }
    }
  };
  await visit(start, [], 1); // an error here (no access to the start page) ends the pass
  return out;
}

// ---------------------------------------------------------------------------------------------------- reading and indexing

/** Read the pages whose edit time moved (or that have no doc yet) into the docs table; at most PASS_PAGES. Returns how many wait. */
async function readPages(client: NotionClient, link: LinkRow, walked: Walked): Promise<number> {
  const known = new Map(docsOf(link.id).map((doc) => [dashed(doc.page_id), doc]));
  let reads = 0;
  let waiting = 0;
  for (const found of walked.candidates) {
    const id = dashed(found.id);
    const doc = known.get(id);
    if (doc && doc.edited_at === found.edited) {
      // Not edited: no read. Where it sits may have changed (the scope, a renamed parent): that is kept without one.
      if (doc.path !== found.path.join(' / ')) saveDoc({ ...doc, path: found.path.join(' / ') });
      continue;
    }
    if (reads >= PASS_PAGES) {
      waiting++;
      continue;
    }
    reads++;
    try {
      const page = found.row ?? (await client.page(id));
      const markdown = await client.pageMarkdown(id);
      const text = markdown.markdown.slice(0, MAX_MARKDOWN_CHARS);
      saveDoc({
        link_id: link.id,
        page_id: id,
        title: found.title,
        url: page.url,
        path: found.path.join(' / '),
        edited_at: found.edited,
        hash: sha(text),
        markdown: text,
        truncated: markdown.truncated || markdown.markdown.length > MAX_MARKDOWN_CHARS ? 1 : 0,
      });
    } catch (error) {
      // A page that went away between the listing and the read is dropped by the next pass; any other failure is retried then.
      logger.warn('[notion-brain] knowledge walk: a page could not be read', { link: link.id, error: (error as Error).message });
    }
  }
  return waiting;
}

/** Docs the walk no longer finds (not Landflow's own notes docs, which NB05 owns) are deleted with their chunks. */
async function dropGone(link: LinkRow, walked: Walked, vectors: SqliteVectorStore): Promise<void> {
  if (!walked.complete) return;
  const present = new Set(walked.candidates.map((c) => compact(c.id)));
  const items = new Set(itemsOf(link.id).map((item) => compact(item.notion_id)));
  for (const doc of docsOf(link.id)) {
    if (present.has(compact(doc.page_id)) || items.has(compact(doc.page_id))) continue;
    dropDoc(link.id, doc.page_id);
    await vectors.deleteWhere(notionKnowledgeCollection(link.project_id), { linkId: link.id, pageId: dashed(doc.page_id) }); // once per gone page
  }
}

/** Chunk and index every doc whose hash differs from what the collection holds (a notes doc included); at most PASS_PAGES. */
async function indexDocs(link: LinkRow, vectors: SqliteVectorStore, model: string | undefined): Promise<number> {
  const collection = notionKnowledgeCollection(link.project_id);
  const held = new Map<string, string>();
  const docs = docsOf(link.id);
  const live = new Set(docs.map((doc) => dashed(doc.page_id)));
  const gone = new Set<string>();
  for (const { metadata } of await vectors.metadataOf(collection)) {
    if (metadata.linkId === link.id && typeof metadata.pageId === 'string') {
      // The chunks keep the page's hash and where it sits: a moved page is indexed again so their `path` follows.
      if (live.has(metadata.pageId)) held.set(metadata.pageId, `${String(metadata.hash ?? '')}|${String(metadata.path ?? '')}`);
      else gone.add(metadata.pageId); // a chunk of a doc that is gone
    }
  }
  for (const pageId of gone) await vectors.deleteWhere(collection, { linkId: link.id, pageId });
  const embeddings = embeddingsOf(model);
  let done = 0;
  let waiting = 0;
  for (const doc of docs) {
    const id = dashed(doc.page_id);
    if (held.get(id) === `${doc.hash ?? ''}|${doc.path ?? ''}`) continue;
    if (done >= PASS_PAGES) {
      waiting++;
      continue;
    }
    const title = doc.title ?? 'Untitled';
    const chunks = recursiveCharacterSplit(doc.markdown ?? '', CHUNK).filter((chunk) => chunk.trim());
    try {
      const texts = (chunks.length ? chunks : [title]).map((chunk) => `${title}\n${chunk}`);
      const vectorsOf = await embeddings.embedDocuments(texts);
      await vectors.deleteWhere(collection, { linkId: link.id, pageId: id });
      await insertDocuments(
        vectors,
        collection,
        texts.map((text, i) => ({
          id: `${link.id}:${id}:${i}`,
          pageContent: text,
          metadata: { linkId: link.id, pageId: id, title, url: doc.url ?? '', path: doc.path ?? '', hash: doc.hash ?? '', editedAt: doc.edited_at ?? '', chunk: i } satisfies JsonObject,
          embedding: vectorsOf[i],
        })),
      );
      done++;
    } catch (error) {
      // Embeddings down (or a dimension clash): keep what is indexed, retry at the next pass.
      logger.warn('[notion-brain] knowledge walk: a page could not be indexed', { link: link.id, error: (error as Error).message });
      break;
    }
  }
  return waiting;
}

/** One pass of the walk for one link. `step` below wraps it with the 15-minute wait. */
export async function walkKnowledge(link: LinkRow, client: NotionClient = readClient(link)): Promise<{ pages: number; waiting: number }> {
  const vectors = new SqliteVectorStore();
  const collection = notionKnowledgeCollection(link.project_id);
  const cursor = (readCursors(link).knowledge ?? {}) as KnowledgeCursor;
  // The model when it answers, else keyword vectors: a collection holds one or the other, so a change clears it and the docs are indexed again.
  const embeddingsKey = await usableEmbeddings();
  if (cursor.embeddings !== embeddingsKey && (await vectors.count(collection)) > 0) await vectors.clear(collection);
  const next: KnowledgeCursor = { at: new Date().toISOString(), embeddings: embeddingsKey };
  let waiting = 0;
  let pages = 0;
  try {
    const walked = await walk(client, link);
    pages = walked.candidates.length;
    waiting += await readPages(client, link, walked);
    await dropGone(link, walked, vectors);
    waiting += await indexDocs(link, vectors, embeddingsKey === 'bm25' ? undefined : embeddingsKey);
  } catch (error) {
    writeCursor(link.id, { ...next, error: (error as Error).message.slice(0, 200) });
    throw error;
  }
  writeCursor(link.id, { ...next, ...(waiting > 0 && { pending: waiting }) });
  return { pages, waiting };
}

/** The sync service's knowledge step. */
export const knowledgeStep: SyncStep = async (link, { force }) => {
  if (!notionBrainEnabled()) return;
  const cursor = (readCursors(link).knowledge ?? {}) as KnowledgeCursor;
  const due = force || !cursor.at || (cursor.pending ?? 0) > 0 || Date.now() - Date.parse(cursor.at) >= WALK_INTERVAL_MS;
  if (!due) return;
  await walkKnowledge(link);
};

setKnowledgeStep(knowledgeStep); // registered when runtime.ts loads this file

// ---------------------------------------------------------------------------------------------------- reading it back

/** Whether a project's Notion knowledge can be read: its link is active and the Notion brain is on. */
const readable = (link: LinkRow | undefined): link is LinkRow => Boolean(link && link.status === 'active' && notionBrainEnabled());

/** The project's active link, when it has one. */
export const activeLinkOf = (projectId: string): LinkRow | undefined => {
  const link = getLink(projectId);
  return readable(link) ? link : undefined;
};

/** The collection a project's Notion pages are indexed in. */
export { notionKnowledgeCollection };

/**
 * The passages of the company's Notion pages that answer `query`, best first, one per page, from the projects in `projects`
 * (undefined: every project with an active link). Keyword search always; meaning too when the brain's embeddings are on (and
 * answering). Never calls Notion.
 */
export async function searchNotionKnowledge(query: string, options: { projects?: Set<string> | undefined; limit?: number; signal?: AbortSignal } = {}): Promise<KnowledgeHit[]> {
  const text = query.trim();
  const limit = Math.max(1, Math.min(50, options.limit ?? ASK_KNOWLEDGE_LIMIT));
  if (!text || !notionBrainEnabled()) return [];
  const links = listActiveLinks().filter((link) => link.status === 'active' && (!options.projects || options.projects.has(link.project_id)));
  if (!links.length) return [];
  const vectors = new SqliteVectorStore();
  const found: Array<KnowledgeHit & { key: string }> = [];
  // The query is embedded with the model a collection holds (its cursor), once per model; one that does not answer in 10 s means keywords.
  const vectorsByModel = new Map<string, number[] | null>();
  for (const link of links) {
    const model = heldModel(link);
    const collection = notionKnowledgeCollection(link.project_id);
    try {
      if ((await vectors.count(collection)) === 0) continue;
      if (model && !vectorsByModel.has(model)) {
        try {
          const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
          vectorsByModel.set(model, await embeddingsOf(model).embedQuery(text, signal));
        } catch (error) {
          vectorsByModel.set(model, null);
          logger.warn('notion knowledge: the query could not be embedded; searching by keywords only', { error: (error as Error).message });
        }
      }
      const vector = model ? vectorsByModel.get(model) : undefined;
      const mode: SearchMode = vector ? 'hybrid' : 'keyword';
      const documents = await searchStore(vectors, collection, { query: text, vector: vector ?? [], topK: limit * 3, mode });
      for (const doc of documents) {
        const meta = doc.metadata as Record<string, unknown>;
        found.push({ key: `${link.id}:${String(meta.pageId)}`, title: String(meta.title ?? 'Untitled'), url: String(meta.url ?? ''), passage: doc.pageContent, score: doc.score ?? 0, ...(typeof meta.editedAt === 'string' && meta.editedAt && { editedAt: meta.editedAt }) });
      }
    } catch (error) {
      logger.warn('notion knowledge: a project’s pages could not be searched', { project: link.project_id, error: (error as Error).message });
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => b.score - a.score)
    .filter((hit) => (seen.has(hit.key) ? false : (seen.add(hit.key), true)))
    .slice(0, limit)
    .map(({ key: _key, ...hit }) => hit);
}

// ---------------------------------------------------------------------------------------------------- the agents' tool

/**
 * The vector knowledge tool config for a project's own Notion brain (the runtime builds it; `knowledgeTool` is told the
 * reserved collection is allowed for this path only). With no active link it is an error, shown as the usual unavailable notice.
 */
export function notionBrainKnowledgeConfig(projectId: string, setting?: Pick<NotionBrainKnowledge, 'description'>): VectorKnowledgeBaseConfig | { error: string } {
  const project = getProject(projectId);
  const label = notionBrainLabel(project?.name ?? 'this project');
  if (!activeLinkOf(projectId)) return { error: `${label}: this project has no active Notion link` };
  const link = activeLinkOf(projectId)!;
  const embeddings = knowledgeEmbeddingsSetting(heldModel(link)); // what the collection holds, not what the env asks for now
  return {
    id: PROJECT_KNOWLEDGE_TOOL,
    type: 'knowledge',
    source: 'vector',
    name: label,
    description: `${setting?.description || 'Search the company’s Notion pages for passages that help answer a question'}. ${NOTION_DATA_NOTE}`,
    store: 'sqlite',
    collection: notionKnowledgeCollection(projectId),
    embeddings,
    topK: 4,
    searchMode: embeddings.provider === 'none' ? 'keyword' : 'hybrid',
  };
}
