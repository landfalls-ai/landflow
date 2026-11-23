/**
 * A person's own settings, kept on the server (the table `user_preferences`) so they follow the person to another
 * browser. `PREFERENCE_DEFAULTS` is what a key means until it is set; a stored key this list no longer names is dropped
 * on read. The client caches them in localStorage for the first paint (lib/client/preferences.ts).
 *
 * No zod here: this module loads in the browser on every page, and zod 4 probes `new Function('')` when it builds an
 * object schema, which the production CSP (no 'unsafe-eval') reports as a violation. The request schemas live in
 * preferences-schema.ts (server only); test/preferences.test.ts keeps the two in step.
 */

export const BRIEFING_DELIVERIES = ['none', 'slack', 'email'] as const;
export type BriefingDelivery = (typeof BRIEFING_DELIVERIES)[number];

export interface Preferences {
  /** Show developer details (ids, raw JSON, timings) where the screens hide them. */
  developerDetails: boolean;
  /** Keep my conversations with Spotlight, the brain and the Agent architect (docs/assistant.md#conversation-history). */
  keepConversations: boolean;
  /** How the person wants their briefing delivered. */
  briefingDelivery: BriefingDelivery;
}
export type PreferenceKey = keyof Preferences;

export const PREFERENCE_DEFAULTS: Preferences = { developerDetails: false, keepConversations: true, briefingDelivery: 'none' };

const VALID: { [K in PreferenceKey]: (value: unknown) => value is Preferences[K] } = {
  developerDetails: (value): value is boolean => typeof value === 'boolean',
  keepConversations: (value): value is boolean => typeof value === 'boolean',
  briefingDelivery: (value): value is BriefingDelivery => (BRIEFING_DELIVERIES as readonly unknown[]).includes(value),
};

/** Stored or cached text as preferences: defaults fill what is missing or invalid, unknown keys go. */
export function readPreferences(raw: unknown): Preferences {
  const value = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(PREFERENCE_DEFAULTS) as PreferenceKey[]) {
    out[key] = VALID[key](value[key]) ? value[key] : PREFERENCE_DEFAULTS[key];
  }
  return out as unknown as Preferences;
}
