/** Request schemas shared by the evaluation routes. */
import { z } from 'zod';

/** PUT of an agent's or AI Agent node's online grading settings (missing fields keep their value). */
export const onlineEvalConfigSchema = z.object({
  enabled: z.boolean().optional(),
  sampleRate: z.number().min(0).max(100).optional(),
  rubric: z.string().max(20_000).optional(),
  model: z
    .object({
      provider: z.enum(['anthropic', 'openai', 'ollama']),
      model: z.string().min(1),
      credential: z.object({ id: z.string(), name: z.string() }).optional(),
      baseUrl: z.string().optional(),
      temperature: z.number().min(0).max(2).optional(),
    })
    .nullable()
    .optional(),
  lowScore: z.number().min(1).max(5).optional(),
});

export type OnlineEvalConfigBody = z.infer<typeof onlineEvalConfigSchema>;
