/** Request schemas of the practices routes (server-only: the shared contract has no zod). */
import { z } from 'zod';
import { PRACTICE_LEVELS, PRACTICE_LIMITS, PRACTICE_STATUSES, PRACTICE_STRENGTHS, PRACTICE_TOPIC } from '../../shared/practices';
import { limitParam, pageSchema } from '../pagination';

const text = (max: number) => z.string().max(max * 4);
const list = (max: number) => z.array(z.string().max(300)).max(max);

const check = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pathExists'), glob: z.string().max(PRACTICE_LIMITS.glob), when: z.string().max(PRACTICE_LIMITS.glob).optional() }),
  z.object({ kind: z.literal('pathAbsent'), glob: z.string().max(PRACTICE_LIMITS.glob), unless: z.string().max(PRACTICE_LIMITS.glob).optional() }),
  z.object({ kind: z.literal('fileMatches'), glob: z.string().max(PRACTICE_LIMITS.glob), pattern: z.string().max(PRACTICE_LIMITS.pattern), absent: z.boolean().optional() }),
]);

const citation = z.object({
  repo: z.string().max(210),
  sha: z.string().max(40),
  path: z.string().max(300),
  lines: z.tuple([z.number().int(), z.number().int()]).optional(),
  excerpt: z.string().max(PRACTICE_LIMITS.excerpt),
});

const fields = {
  title: text(PRACTICE_LIMITS.title),
  strength: z.enum(PRACTICE_STRENGTHS),
  topics: list(PRACTICE_LIMITS.topics),
  repos: list(PRACTICE_LIMITS.repos),
  paths: list(PRACTICE_LIMITS.paths),
  summary: text(PRACTICE_LIMITS.summary),
  body: text(PRACTICE_LIMITS.body),
  checks: z.array(check).max(PRACTICE_LIMITS.checks),
  citations: z.array(citation).max(PRACTICE_LIMITS.citations),
};

/** POST /api/practices: a new practice. */
export const draftSchema = z.object({
  handle: z.string().max(120),
  level: z.enum(PRACTICE_LEVELS),
  projectId: z.string().max(100).optional(),
  ...fields,
  checks: fields.checks.optional(),
  citations: fields.citations.optional(),
});

/** PATCH /api/practices/:id: any of the fields; the rest come from the newest version. */
export const patchSchema = z
  .object({
    title: fields.title,
    strength: fields.strength,
    topics: fields.topics,
    repos: fields.repos,
    paths: fields.paths,
    summary: fields.summary,
    body: fields.body,
    checks: fields.checks,
    citations: fields.citations,
  })
  .partial()
  .refine((value) => Object.keys(value).length > 0, 'Send at least one field to change');

export const approveSchema = z.object({
  version: z.number().int().min(1),
  reviewedSources: z.boolean().optional(),
  conflicts: z.record(z.string(), z.enum(['supersede', 'keep'])).optional(),
});

const reason = z.string().trim().min(PRACTICE_LIMITS.reasonMin).max(PRACTICE_LIMITS.reason);
export const rejectSchema = z.object({ reason });
export const waiverSchema = z.object({ executionId: z.string().min(1).max(200), version: z.number().int().min(1), reason });

export const listQuery = z.object({
  status: z.enum(PRACTICE_STATUSES).optional(),
  level: z.enum(PRACTICE_LEVELS).optional(),
  projectId: z.string().max(100).optional(),
  topic: z.string().regex(PRACTICE_TOPIC).optional(),
  q: z.string().trim().max(100).optional(),
});

export const applicationsQuery = pageSchema.extend({ limit: limitParam(100, 50) });
