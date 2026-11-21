/** The body of `POST /api/memory/search` (C11). Server only: the shared shapes are lib/shared/memory-playground.ts. */
import { z } from 'zod';
import { PLAYGROUND_LIMITS } from '../../shared/memory-playground';

const source = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('kb'), agentId: z.string().min(1).max(200), toolId: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('notebook'), teamId: z.string().min(1).max(200), projectId: z.string().min(1).max(200).optional() }),
  z.object({ kind: z.literal('facts'), projectId: z.string().min(1).max(200).optional() }),
]);

const rerank = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cohere'), credentialId: z.string().min(1).max(200), model: z.string().max(200).optional() }),
  z.object({ kind: z.literal('llm'), model: z.string().min(1).max(200) }),
]);

export const playgroundSchema = z.object({
  source,
  query: z.string().max(PLAYGROUND_LIMITS.query, `Keep the query under ${PLAYGROUND_LIMITS.query} characters`),
  mode: z.enum(['keyword', 'meaning', 'hybrid']).default('hybrid'),
  limit: z.number().int().min(PLAYGROUND_LIMITS.limit.min).max(PLAYGROUND_LIMITS.limit.max).default(PLAYGROUND_LIMITS.limit.default),
  threshold: z.number().min(0).max(1).default(0),
  rerank: rerank.optional(),
});
