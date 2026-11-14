/**
 * A person's kept conversations (docs/assistant.md#conversation-history). Every function takes the user id and filters by
 * it in SQL, so another person's id is simply not found: there is no admin read, by design. Lists are keyset-paged by
 * `updated_at, id` (lib/server/pagination.ts). A conversation and its items are deleted together, in one transaction.
 */
import { nanoid } from 'nanoid';
import {
  CONVERSATION_SURFACES,
  NEW_CONVERSATION_TITLE,
  titleFrom,
  type ConversationItem,
  type ConversationItemInput,
  type ConversationMeta,
  type ConversationPart,
  type ConversationRecord,
  type ConversationSurface,
  type CreateConversation,
} from '../../shared/conversations';
import { database } from '../db';
import { decodeCursor, encodeCursor } from '../pagination';

interface ConversationRow {
  id: string;
  surface: string;
  project_id: string | null;
  subject_type: string | null;
  subject_id: string | null;
  title: string;
  pinned: number;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  seq: number;
  role: string;
  parts: string;
  meta: string | null;
  at: string;
}

const COLUMNS = 'id, surface, project_id, subject_type, subject_id, title, pinned, created_at, updated_at';

function fromRow(row: ConversationRow): ConversationRecord {
  return {
    id: row.id,
    surface: (CONVERSATION_SURFACES as readonly string[]).includes(row.surface) ? (row.surface as ConversationSurface) : 'spotlight',
    projectId: row.project_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    title: row.title,
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const parse = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function itemFromRow(row: ItemRow): ConversationItem {
  return { seq: row.seq, role: row.role === 'assistant' ? 'assistant' : 'user', parts: parse<ConversationPart[]>(row.parts, []), ...(row.meta && { meta: parse<ConversationMeta>(row.meta, {}) }), at: row.at };
}

/** Escapes `%`, `_` and the escape character so a search is plain text. */
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export function createConversation(userId: string, input: CreateConversation): ConversationRecord {
  const now = new Date().toISOString();
  const row: ConversationRow = {
    id: `cv_${nanoid(12)}`,
    surface: input.surface,
    project_id: input.projectId ?? null,
    subject_type: input.subjectType ?? null,
    subject_id: input.subjectId ?? null,
    title: input.title?.trim() ? titleFrom(input.title) : NEW_CONVERSATION_TITLE,
    pinned: 0,
    created_at: now,
    updated_at: now,
  };
  database().upsert('conversations', { ...row, user_id: userId });
  return fromRow(row);
}

export interface ConversationQuery {
  surface?: string;
  subjectType?: string;
  subjectId?: string;
  q?: string;
  limit: number;
  cursor?: string;
}

/** The person's conversations, newest first, one page. */
export function listConversations(userId: string, query: ConversationQuery): { conversations: ConversationRecord[]; nextCursor: string | null } {
  const where = ['c.user_id = ?'];
  const params: Array<string | number> = [userId];
  if (query.surface) {
    where.push('c.surface = ?');
    params.push(query.surface);
  }
  if (query.subjectType) {
    where.push('c.subject_type = ?');
    params.push(query.subjectType);
  }
  if (query.subjectId) {
    where.push('c.subject_id = ?');
    params.push(query.subjectId);
  }
  if (query.q?.trim()) {
    const like = likePattern(query.q.trim().toLowerCase());
    // Titles and the person's own words; what the assistant answered is not searched.
    where.push(
      `(LOWER(c.title) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM conversation_items i WHERE i.conversation_id = c.id AND i.role = 'user' AND LOWER(i.parts) LIKE ? ESCAPE '\\'))`,
    );
    params.push(like, like);
  }
  const cursor = query.cursor ? decodeCursor(query.cursor) : undefined;
  if (cursor) {
    where.push('(c.updated_at < ? OR (c.updated_at = ? AND c.id < ?))');
    params.push(cursor.s, cursor.s, cursor.i);
  }
  const rows = database().all<ConversationRow>(
    `SELECT ${COLUMNS.split(', ').map((c) => `c.${c}`).join(', ')} FROM conversations c WHERE ${where.join(' AND ')} ORDER BY c.updated_at DESC, c.id DESC LIMIT ?`,
    ...params,
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  const last = page[page.length - 1];
  return { conversations: page.map(fromRow), nextCursor: rows.length > query.limit && last ? encodeCursor({ s: last.updated_at, i: last.id }) : null };
}

/** The person's conversation, or undefined when it doesn't exist or is someone else's. */
export function getConversation(userId: string, id: string): ConversationRecord | undefined {
  const row = database().get<ConversationRow>(`SELECT ${COLUMNS} FROM conversations WHERE id = ? AND user_id = ?`, id, userId);
  return row && fromRow(row);
}

/** The items of one of the person's conversations, oldest first (empty for an id that isn't theirs). */
export function listItems(userId: string, id: string): ConversationItem[] {
  if (!getConversation(userId, id)) return [];
  return database()
    .all<ItemRow>('SELECT seq, role, parts, meta, at FROM conversation_items WHERE conversation_id = ? ORDER BY seq', id)
    .map(itemFromRow);
}

/** Rename or pin. Returns the conversation, or undefined when it isn't the person's. */
export function updateConversation(userId: string, id: string, patch: { title?: string; pinned?: boolean }): ConversationRecord | undefined {
  const db = database();
  return db.transaction(() => {
    const row = db.get<ConversationRow & { user_id: string }>(`SELECT ${COLUMNS}, user_id FROM conversations WHERE id = ? AND user_id = ?`, id, userId);
    if (!row) return undefined;
    const next = { ...row, ...(patch.title !== undefined && { title: titleFrom(patch.title) }), ...(patch.pinned !== undefined && { pinned: patch.pinned ? 1 : 0 }) };
    db.upsert('conversations', next);
    return fromRow(next);
  });
}

/** Delete the conversation and its items for good. False when it isn't the person's. */
export function deleteConversation(userId: string, id: string): boolean {
  const db = database();
  return db.transaction(() => {
    if (!getConversation(userId, id)) return false;
    db.delete('conversation_items', { conversation_id: id });
    db.delete('conversations', { id, user_id: userId });
    return true;
  });
}

/** Add items after the last one; returns the last `seq`, or undefined when the conversation isn't the person's. */
export function appendItems(userId: string, id: string, items: ConversationItemInput[]): number | undefined {
  const db = database();
  return db.transaction(() => {
    const conversation = getConversation(userId, id);
    if (!conversation) return undefined;
    let seq = Number(db.get<{ last: number | null }>('SELECT MAX(seq) AS last FROM conversation_items WHERE conversation_id = ?', id)?.last ?? 0);
    const now = new Date().toISOString();
    for (const item of items) {
      seq += 1;
      db.upsert('conversation_items', { conversation_id: id, seq, role: item.role, parts: JSON.stringify(item.parts), meta: item.meta ? JSON.stringify(item.meta) : null, at: now });
    }
    // The first thing the person says names a conversation nobody named.
    const firstText = items.find((item) => item.role === 'user')?.parts.find((part) => part.type === 'text');
    const title = conversation.title === NEW_CONVERSATION_TITLE && firstText?.type === 'text' ? titleFrom(firstText.text) : conversation.title;
    db.upsert('conversations', { id, user_id: userId, surface: conversation.surface, project_id: conversation.projectId, subject_type: conversation.subjectType, subject_id: conversation.subjectId, title, pinned: conversation.pinned ? 1 : 0, created_at: conversation.createdAt, updated_at: now });
    return seq;
  });
}

/** Retention: delete the conversations last touched before `cutoff` (ISO time) with their items, 500 at a time. Returns how many. */
export function deleteConversationsBefore(cutoff: string, batch = 500): number {
  const db = database();
  let removed = 0;
  for (;;) {
    const ids = db.all<{ id: string }>('SELECT id FROM conversations WHERE updated_at < ? ORDER BY updated_at LIMIT ?', cutoff, batch).map((row) => row.id);
    if (!ids.length) return removed;
    db.transaction(() => {
      for (const id of ids) {
        db.delete('conversation_items', { conversation_id: id });
        db.delete('conversations', { id });
      }
    });
    removed += ids.length;
    if (ids.length < batch) return removed;
  }
}
