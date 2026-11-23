/**
 * The plan route's and the build route's request schemas, server side only (a module the browser loads builds no zod
 * object schema: the production CSP reports zod's `new Function` probe).
 */
import { z } from 'zod';
import { PLAN_LINES_LIMIT, PLAN_STEP_LIMIT } from '@/lib/shared/build-plan';

const Short = (max: number) => z.string().trim().max(max);

/** A `BuildPlan` (lib/shared/build-plan.ts) as a request carries it: at most `PLAN_STEP_LIMIT` steps, every string bounded. */
export const PlanSchema = z.object({
  name: Short(80),
  steps: z
    .array(
      z.object({
        key: Short(40).min(1),
        type: Short(120).min(1),
        name: Short(60),
        does: Short(300),
        from: Short(40).optional(),
        output: z.number().int().min(0).max(50).optional(),
        attach: Short(40).optional(),
        reads: z.array(Short(80)).max(20).optional(),
      }),
    )
    .max(PLAN_STEP_LIMIT),
  assumptions: z.array(Short(300)).max(PLAN_LINES_LIMIT),
  cannot: z.array(Short(300)).max(PLAN_LINES_LIMIT),
});

export const PlanBody = z.object({
  prompt: z.string().trim().min(3).max(2000),
  model: z.string().max(100).optional(),
  workflowId: z.string().max(64).optional(),
  plan: PlanSchema.optional(),
  change: z.string().trim().min(1).max(500).optional(),
});
