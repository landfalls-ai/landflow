/**
 * The request bodies of the custom-role routes (C32). Server only: zod 4 probes `new Function` when it builds an object
 * schema, which the production CSP refuses, so the client modules (lib/shared/roles.ts) hold no zod.
 */
import { z } from 'zod';

/** An action is checked against the live list in ./roles (400 naming the unknown one), not here, so the message names it. */
const rule = z.strictObject({ action: z.string().min(1).max(60), effect: z.literal('allow') });

export const roleCreateSchema = z.strictObject({
  name: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional(),
  rules: z.array(rule).min(1).max(20),
});

export const roleUpdateSchema = z.strictObject({
  name: z.string().trim().min(1).max(40).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  rules: z.array(rule).min(1).max(20).optional(),
});
