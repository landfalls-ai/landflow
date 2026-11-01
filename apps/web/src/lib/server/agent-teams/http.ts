import { z } from 'zod';

/** The body of a team: the draft the editor sends (the store cleans it; `teamIssues` only stops publishing). */
export const teamConfigSchema = z.object({
  name: z.string().max(200).optional(),
  goal: z.string().max(1000).optional(),
  description: z.string().max(1000).optional(),
  members: z.array(z.record(z.string(), z.unknown())).max(50).optional(),
});
