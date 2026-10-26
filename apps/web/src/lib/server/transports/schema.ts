/** Request bodies of the transport routes, and the workflow setting `transports` (shared with the OpenAPI document). */
import { z } from 'zod';

/** A transport kind: http, grpc, kafka… */
export const transportKindSchema = z.string().min(1).max(32).regex(/^[a-z][a-z0-9+.-]*$/, 'A transport kind is lower-case: http, grpc, kafka…');

/** A workflow's override of one plugin's policy (workflow settings `transports`): every field optional. */
export const workflowTransportOverrideSchema = z
  .strictObject({
    mode: z.enum(['auto', 'pinned']).optional(),
    pinned: transportKindSchema.optional(),
    allowed: z.array(transportKindSchema).min(1, 'The allow-list names at least one transport (or leave it out)').max(32).optional(),
    objective: z.enum(['balanced', 'latency', 'throughput']).optional(),
  })
  .superRefine((override, ctx) => {
    if (override.mode === 'pinned' && !override.pinned) ctx.addIssue({ code: 'custom', path: ['pinned'], message: 'A pinned override names the transport' });
    if (override.mode === 'auto' && override.pinned) ctx.addIssue({ code: 'custom', path: ['pinned'], message: 'An Auto override pins nothing' });
    if (override.pinned && override.allowed && !override.allowed.includes(override.pinned)) ctx.addIssue({ code: 'custom', path: ['pinned'], message: 'The pinned transport must be in the allow-list' });
  });

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
