/** The request bodies of the Notion brain routes (lib/shared/notion-brain.ts holds the types the browser shares). */
import { z } from 'zod';
import { KNOWLEDGE_SCOPES, PROBLEM_ACTIONS, RPS_MAX } from '../../../shared/notion-brain';

const credentialId = z.string().trim().min(1).max(200);
const page = z.string().trim().min(1).max(2000);
const rps = z.number().int().min(1).max(RPS_MAX);

export const linkCheckSchema = z.object({ credentialId, page }).strict();
export const linkCreateSchema = z.object({ credentialId, page, knowledgeScope: z.enum(KNOWLEDGE_SCOPES).optional(), rps: rps.optional() }).strict();
export const linkPatchSchema = z
  .object({ paused: z.boolean().optional(), rps: rps.optional(), knowledgeScope: z.enum(KNOWLEDGE_SCOPES).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to change' });
export const problemActionSchema = z.object({ action: z.enum(PROBLEM_ACTIONS) }).strict();
