/**
 * The zod schemas for a person's preferences, for the server and the tests only: building a zod object schema in the
 * browser trips the production CSP (see preferences.ts). test/preferences.test.ts keeps them equal to preferences.ts.
 */
import { z } from 'zod';
import { BRIEFING_DELIVERIES } from './preferences';

export const preferencesSchema = z.object({
  developerDetails: z.boolean().default(false),
  keepConversations: z.boolean().default(true),
  briefingDelivery: z.enum(BRIEFING_DELIVERIES).default('none'),
});

/** A change: any of the keys, each with a valid value (no defaults apply here). Unknown keys are dropped. */
export const preferencesPatchSchema = z.object({
  developerDetails: z.boolean().optional(),
  keepConversations: z.boolean().optional(),
  briefingDelivery: z.enum(BRIEFING_DELIVERIES).optional(),
});
