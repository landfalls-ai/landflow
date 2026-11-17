/**
 * A person's kept conversations (docs/assistant.md#conversation-history): the types and zod schemas the routes, the
 * store and the client share. A conversation belongs to one person and one surface; its items are messages made of parts.
 */
import { z } from 'zod';

// As in ui-spec.ts: the browser loads this module (lib/client/conversations.ts uses createBody), and zod probes
// `new Function` when it builds an object schema, which the production CSP reports. Jitless in the browser avoids the probe.
if (typeof window !== 'undefined') z.config({ jitless: true });

export const CONVERSATION_SURFACES = ['spotlight', 'brain', 'architect', 'agent-test'] as const;
export type ConversationSurface = (typeof CONVERSATION_SURFACES)[number];

export const MAX_ITEM_BYTES = 32 * 1024;
export const MAX_ITEMS_PER_APPEND = 20;
export const NEW_CONVERSATION_TITLE = 'New conversation';

const text = z.string().max(MAX_ITEM_BYTES);

/** One step of what the assistant did (the shape of an activity step; declared here so this file stands alone). */
export const stepSchema = z.object({ id: z.string().max(200), label: z.string().max(500), kind: z.string().max(100), status: z.string().max(50), durationMs: z.number().optional() });

// AG11: an agent card Spotlight designed, trimmed to what a person reads (docs/assistant.md "Conversation history"), and the
// row of its Run an Agent step. Bounded strings and arrays like the other parts; `config` only while the item fits.
const short = (max: number) => z.string().max(max);
const smokeSchema = z.object({
  state: z.enum(['testing', 'passed', 'failed', 'untested']),
  reply: short(300).optional(),
  reason: short(1000).optional(),
  ms: z.number().optional(),
  tools: z.array(z.object({ name: short(200), status: z.enum(['success', 'error', 'empty', 'denied']), note: short(500).optional() })).max(30).optional(),
});
const publishSchema = z.object({ state: z.enum(['publishing', 'published', 'held', 'failed']), cases: z.number().optional(), score: z.number().optional(), reason: short(1000).optional() });
export const agentCardPartSchema = z.object({
  name: short(200),
  description: short(2000),
  model: short(200).optional(),
  tools: z.array(z.object({ name: short(200), type: short(200).optional(), operation: short(200).optional(), writes: z.boolean(), requireApproval: z.boolean() })).max(60),
  knowledge: short(300).optional(),
  practices: z.boolean(),
  guardrails: z.array(short(500)).max(30),
  cases: z.array(z.object({ input: short(2000), expected: short(2000).optional() })).max(30),
  needs: z.array(short(1000)).max(30),
  missing: z.array(short(500)).max(30),
  notAdded: z.array(z.object({ name: short(200), reason: short(500) })).max(30).optional(),
  changes: z.array(short(500)).max(50).optional(),
  models: z.array(short(200)).max(30).optional(),
  state: z.enum(['designed', 'creating', 'created', 'failed']),
  agentId: short(200).optional(),
  workflowId: short(200).optional(),
  error: short(2000).optional(),
  smoke: smokeSchema.optional(),
  publish: publishSchema.optional(),
  starter: z.boolean().optional(),
  ask: short(4000).optional(),
  base: z.object({ agentId: short(200), name: short(200) }).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export const agentRowPartSchema = z.object({
  nodeId: short(200).optional(),
  state: z.enum(['designing', 'testing', 'tested', 'untested', 'publishing', 'published', 'draft', 'failed']),
  smoke: smokeSchema.optional(),
  publish: publishSchema.optional(),
  summary: short(1000).optional(),
  agentId: short(200).optional(),
});

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
  z.object({ type: z.literal('agentCard'), id: z.string().max(200), card: agentCardPartSchema, row: agentRowPartSchema.optional() }), // AG11:
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
  /** A local model answered: the footer says "local" in place of a cost. */
  local: z.boolean().optional(),
});
/** What the store keeps beside an item, plus `hidden` that a read adds: the links it dropped for lack of access. */
export type ConversationMeta = z.infer<typeof conversationMetaSchema> & { hidden?: number };

export const conversationItemInputSchema = z
  .object({ role: z.enum(['user', 'assistant']), parts: z.array(conversationPartSchema).min(1).max(50), meta: conversationMetaSchema.optional() })
  .refine((item) => new TextEncoder().encode(JSON.stringify(item)).length <= MAX_ITEM_BYTES, 'An item is at most 32 KB');
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

/** The body of POST /api/conversations: the scope, and the title clipped to what the schema takes (never the raw message). */
export function createBody(scope: { surface: ConversationSurface; subjectType?: string; subjectId?: string }, firstText?: string) {
  return { ...scope, ...(firstText?.trim() && { title: titleFrom(firstText) }) };
}

/** A title from the first user text: one line, clipped to 80 characters (code points). */
export function titleFrom(textValue: string | undefined): string {
  const line = (textValue ?? '').replace(/\s+/g, ' ').trim();
  if (!line) return NEW_CONVERSATION_TITLE;
  // By code point, so an emoji at the cut is kept whole or left out, never split into half a surrogate pair.
  const chars = Array.from(line);
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : line;
}
