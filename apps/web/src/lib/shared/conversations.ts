/**
 * A person's kept conversations (docs/assistant.md#conversation-history): the types and zod schemas the routes, the
 * store and the client share. A conversation belongs to one person and one surface; its items are messages made of parts.
 */
import { z } from 'zod';

export const CONVERSATION_SURFACES = ['spotlight', 'brain', 'architect', 'agent-test'] as const;
export type ConversationSurface = (typeof CONVERSATION_SURFACES)[number];

export const MAX_ITEM_BYTES = 32 * 1024;
export const MAX_ITEMS_PER_APPEND = 20;
export const NEW_CONVERSATION_TITLE = 'New conversation';

const text = z.string().max(MAX_ITEM_BYTES);

/** One step of what the assistant did (the shape of an activity step; declared here so this file stands alone). */
export const stepSchema = z.object({ id: z.string().max(200), label: z.string().max(500), kind: z.string().max(100), status: z.string().max(50), durationMs: z.number().optional() });

export const conversationPartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text }),
  z.object({ type: z.literal('steps'), steps: z.array(stepSchema).max(200) }),
  z.object({ type: z.literal('proposal'), id: z.string().max(200), summary: text, ops: z.array(z.unknown()).max(500), state: z.enum(['pending', 'applied', 'dismissed', 'stale']) }),
  z.object({ type: z.literal('mentions'), refs: z.array(z.object({ type: z.string().max(100), id: z.string().max(200), workflowId: z.string().max(200).optional(), name: z.string().max(500) })).max(100) }),
  z.object({
    type: z.literal('answer'),
    text,
    links: z.array(z.object({ type: z.string().max(100), id: z.string().max(200), name: z.string().max(500) })).max(100),
    sources: z.array(z.object({ n: z.number(), title: z.string().max(500), url: z.string().max(2000).optional() })).max(100).optional(),
  }),
  z.object({ type: z.literal('error'), message: z.string().max(4000), kind: z.string().max(100).optional() }),
]);
export type ConversationPart = z.infer<typeof conversationPartSchema>;

export const conversationMetaSchema = z.object({
  model: z.string().max(200).optional(),
  durationMs: z.number().optional(),
  steps: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  costUsd: z.number().optional(),
});
/** What the store keeps beside an item, plus `hidden` that a read adds: the links it dropped for lack of access. */
export type ConversationMeta = z.infer<typeof conversationMetaSchema> & { hidden?: number };

export const conversationItemInputSchema = z
  .object({ role: z.enum(['user', 'assistant']), parts: z.array(conversationPartSchema).min(1).max(50), meta: conversationMetaSchema.optional() })
  .refine((item) => JSON.stringify(item).length <= MAX_ITEM_BYTES, 'An item is at most 32 KB');
export type ConversationItemInput = z.infer<typeof conversationItemInputSchema>;

export const appendItemsSchema = z.object({ items: z.array(conversationItemInputSchema).min(1).max(MAX_ITEMS_PER_APPEND) });

export const createConversationSchema = z.object({
  surface: z.enum(CONVERSATION_SURFACES),
  subjectType: z.string().max(100).optional(),
  subjectId: z.string().max(200).optional(),
  projectId: z.string().max(200).optional(),
  title: z.string().max(200).optional(),
});
export type CreateConversation = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional() });

export interface ConversationRecord {
  id: string;
  surface: ConversationSurface;
  projectId: string | null;
  subjectType: string | null;
  subjectId: string | null;
  title: string;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationItem {
  seq: number;
  role: 'user' | 'assistant';
  parts: ConversationPart[];
  meta?: ConversationMeta;
  at: string;
}

/** A title from the first user text: one line, clipped to 80 characters. */
export function titleFrom(textValue: string | undefined): string {
  const line = (textValue ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return NEW_CONVERSATION_TITLE;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
