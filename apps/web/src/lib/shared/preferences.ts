/**
 * A person's own settings, kept on the server (the table `user_preferences`) so they follow the person to another
 * browser. `PREFERENCE_DEFAULTS` is what a key means until it is set; a stored key this list no longer names is dropped
 * on read. The client caches them in localStorage for the first paint (lib/client/preferences.ts).
 */
import { z } from 'zod';

export const BRIEFING_DELIVERIES = ['none', 'slack', 'email'] as const;

export const preferencesSchema = z.object({
  /** Show developer details (ids, raw JSON, timings) where the screens hide them. */
  developerDetails: z.boolean().default(false),
  /** Keep my conversations with Spotlight, the brain and the Agent architect (docs/assistant.md#conversation-history). */
  keepConversations: z.boolean().default(true),
  /** How the person wants their briefing delivered. */
  briefingDelivery: z.enum(BRIEFING_DELIVERIES).default('none'),
});
export type Preferences = z.infer<typeof preferencesSchema>;
export type PreferenceKey = keyof Preferences;

export const PREFERENCE_DEFAULTS: Preferences = preferencesSchema.parse({});

/** A change: any of the keys, each with a valid value (no defaults apply here). Unknown keys are dropped. */
export const preferencesPatchSchema = z.object({
  developerDetails: z.boolean().optional(),
  keepConversations: z.boolean().optional(),
  briefingDelivery: z.enum(BRIEFING_DELIVERIES).optional(),
});

/** Stored or cached text as preferences: defaults fill what is missing or invalid, unknown keys go. */
export function readPreferences(raw: unknown): Preferences {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(PREFERENCE_DEFAULTS) as PreferenceKey[]) {
    const field = preferencesSchema.shape[key].safeParse(value[key]);
    out[key] = field.success ? field.data : PREFERENCE_DEFAULTS[key];
  }
  return out as unknown as Preferences;
}
