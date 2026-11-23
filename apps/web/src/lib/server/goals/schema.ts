/** Request bodies and queries of the goals routes (docs/projects-and-goals.md#the-api). Server-only: it uses zod. */
import { z } from 'zod';
import { BRIEF_LIMITS, GOAL_LEVELS, GOAL_LIMITS, GOAL_STATUSES, PROJECT_STATUSES } from '../../shared/goals';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const title = z.string().trim().min(1).max(GOAL_LIMITS.title);
const why = z.string().max(GOAL_LIMITS.why);
const id = z.string().min(1).max(100);

/** POST /api/goals. `projectId` is required when and only when `level` is `project`. */
export const createGoalSchema = z
  .strictObject({
    title,
    why: why.optional(),
    level: z.enum(GOAL_LEVELS),
    status: z.enum(GOAL_STATUSES).optional(),
    ownerId: id.optional(),
    targetDate: date.optional(),
    parentId: id.optional(),
    projectId: id.optional(),
    projectIds: z.array(id).max(GOAL_LIMITS.goalsPerProject).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.level === 'project' && !body.projectId) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'A project goal needs a projectId' });
    if (body.level === 'company' && body.projectId) ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'A company goal has no projectId' });
    if (body.level === 'project' && body.projectIds?.length) ctx.addIssue({ code: 'custom', path: ['projectIds'], message: 'Only a company goal lists the projects that serve it' });
  });
export type CreateGoalBody = z.infer<typeof createGoalSchema>;

/** PATCH /api/goals/:id (null clears). */
export const updateGoalSchema = z.strictObject({
  title: title.optional(),
  why: why.nullable().optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  ownerId: id.nullable().optional(),
  targetDate: date.nullable().optional(),
  parentId: id.nullable().optional(),
});
export type UpdateGoalBody = z.infer<typeof updateGoalSchema>;

// PC17: `progress=1` adds each goal's progress; `window` is 7 or 30 days (default 7).
const progressWindow = z.enum(['7', '30']).transform((value) => Number(value) as 7 | 30);
export const goalsQuerySchema = z.object({ projectId: z.string().optional(), status: z.enum(GOAL_STATUSES).optional(), progress: z.enum(['1']).optional(), window: progressWindow.optional() });
export const goalProgressQuerySchema = z.object({ window: progressWindow.default(7) });

export const initiativesSchema = z.strictObject({ ids: z.array(id).max(GOAL_LIMITS.initiatives) });
export const projectGoalsSchema = z.strictObject({ goalIds: z.array(id).max(GOAL_LIMITS.goalsPerProject) });

/** `brief` of PATCH /api/projects/:id. */
export const briefPatchSchema = z.strictObject({
  brief: z.string().max(BRIEF_LIMITS.brief).nullable().optional(),
  constraints: z.string().max(BRIEF_LIMITS.constraints).nullable().optional(),
  doneWhen: z.string().max(BRIEF_LIMITS.doneWhen).nullable().optional(),
  glossary: z.string().max(BRIEF_LIMITS.glossary).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).nullable().optional(),
  targetDate: date.nullable().optional(),
  leadId: id.nullable().optional(),
  decisionOwnerId: id.nullable().optional(),
});
