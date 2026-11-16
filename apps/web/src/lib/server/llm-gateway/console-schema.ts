import { z } from "zod";
import { CALL_PURPOSES } from "../../shared/ai-call";
import {
  AI_SPEND_GROUPS,
  AI_SPEND_MAX_DAYS,
  AI_SPEND_PERIODS,
  type AiSpendFilters,
  type AiSpendPeriod,
  type AiSpendGroup,
} from "../../shared/ai-spend";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A day is YYYY-MM-DD");
const id = z.string().trim().min(1).max(200);
const dayMs = (value: string) =>
  Date.UTC(
    Number(value.slice(0, 4)),
    Number(value.slice(5, 7)) - 1,
    Number(value.slice(8, 10)),
  );

/**
 * GET /api/insights/ai?period=24h|7d|30d|90d|custom (a custom period needs `from` and `to`: days, `from` not after `to`,
 * at most 400 days; not after today is checked with the report) &projectId= &agentId= &workflowId= &userId=
 * &credentialId= &model= &purpose= &source= &surface= &compare=1 &stack=<group>
 */
export const aiConsoleQuerySchema = z
  .object({
    period: z.enum(AI_SPEND_PERIODS).default("7d"),
    from: day.optional(),
    to: day.optional(),
    projectId: id.optional(),
    agentId: id.optional(),
    workflowId: id.optional(),
    userId: id.optional(),
    credentialId: id.optional(),
    model: id.optional(),
    purpose: z.enum([...CALL_PURPOSES, "none"]).optional(),
    source: id.optional(),
    surface: id.optional(),
    compare: z.enum(["1", "0", "true", "false"]).optional(),
    stack: z.enum(AI_SPEND_GROUPS).optional(),
  })
  .superRefine((query, ctx) => {
    if (query.period !== "custom") return;
    if (!query.from || !query.to)
      return void ctx.addIssue({
        code: "custom",
        message: "A custom range needs from and to",
        path: ["from"],
      });
    if (Number.isNaN(dayMs(query.from)) || Number.isNaN(dayMs(query.to)))
      return void ctx.addIssue({
        code: "custom",
        message: "from and to are days: YYYY-MM-DD",
        path: ["from"],
      });
    if (query.from > query.to)
      return void ctx.addIssue({
        code: "custom",
        message: "from must not be after to",
        path: ["from"],
      });
    if (
      (dayMs(query.to) - dayMs(query.from)) / 86_400_000 + 1 >
      AI_SPEND_MAX_DAYS
    )
      ctx.addIssue({
        code: "custom",
        message: `A custom range spans at most ${AI_SPEND_MAX_DAYS} days`,
        path: ["to"],
      });
  });

export type AiConsoleQuery = z.infer<typeof aiConsoleQuerySchema>;

/** The query as the report takes it. */
export function spendQueryOf(query: AiConsoleQuery): {
  period: AiSpendPeriod;
  from?: string;
  to?: string;
  filters: AiSpendFilters;
  compare: boolean;
  stack?: AiSpendGroup;
} {
  const { period, from, to, compare, stack, ...filters } = query;
  return {
    period,
    ...(period === "custom" && { from, to }),
    filters,
    compare: compare === "1" || compare === "true",
    ...(stack && { stack }),
  };
}
