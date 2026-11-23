/** Request bodies and queries of the project task routes (docs/projects-and-goals.md#tasks). Server-only: it uses zod. */
import { z } from 'zod';
import { TASK_LIMITS, TASK_PRIORITIES, TASK_STATUSES } from '../../shared/project-tasks';
import { decodeCursor, limitParam } from '../pagination';

const id = z.string().min(1).max(100);

/** POST and PATCH of a task (PATCH: every field optional; null clears an optional one). POST needs `title`. */
const fields = {
  title: z.string().trim().min(1, 'Give the task a title').max(TASK_LIMITS.title),
  description: z.string().max(TASK_LIMITS.description).nullable().optional(),
  status: z.enum(TASK_STATUSES).optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  goalId: id.nullable().optional(),
  parentId: id.nullable().optional(),
  assignee: z.strictObject({ kind: z.enum(['agent', 'person']), id }).nullable().optional(),
  wake: z.strictObject({ cron: z.string().trim().min(1).max(100) }).nullable().optional(),
};
export const createTaskSchema = z.strictObject(fields);
export const updateTaskSchema = z.strictObject({ ...fields, title: fields.title.optional() });
export type CreateTaskBody = z.infer<typeof createTaskSchema>;
export type UpdateTaskBody = z.infer<typeof updateTaskSchema>;

/** GET /api/projects/:id/tasks */
export const listTasksQuery = z.object({
  limit: limitParam(),
  cursor: z
    .string()
    .max(512)
    .refine((text) => decodeCursor(text) !== undefined, 'Not a cursor from this API')
    .optional(),
  status: z.enum(TASK_STATUSES).optional(),
  mine: z.enum(['1', 'true']).optional(),
});

/** POST /api/task-runs/:runId */
export const decisionSchema = z.strictObject({ decision: z.enum(['approve', 'deny']) });
