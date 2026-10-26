/** Request bodies of the connection routes (shared with the OpenAPI document). */
import { z } from 'zod';

const configSchema = z.record(z.string().max(64), z.union([z.string().max(20_000), z.boolean()]));
/** A secret left empty keeps its saved value; null clears it. */
const secretsSchema = z.record(z.string().max(64), z.union([z.string().max(20_000), z.null()]));

export const connectionCreateSchema = z.strictObject({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
    .optional(),
  name: z.string().min(1).max(64),
  kind: z.string().min(1).max(32),
  enabled: z.boolean().optional(),
  config: configSchema.optional(),
  secrets: secretsSchema.optional(),
});

export const connectionUpdateSchema = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  config: configSchema.optional(),
  secrets: secretsSchema.optional(),
});

/** POST …/test with a body tests the form's values before they are saved. */
export const connectionTestSchema = z.strictObject({
  kind: z.string().min(1).max(32).optional(),
  name: z.string().max(64).optional(),
  config: configSchema.optional(),
  secrets: secretsSchema.optional(),
});
