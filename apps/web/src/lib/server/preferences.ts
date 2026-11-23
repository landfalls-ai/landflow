/**
 * Personal preferences on the server (lib/shared/preferences.ts names the keys): one row per person in
 * `user_preferences`, the settings as JSON. Only the person's own row is ever read or written; the route passes the
 * signed-in user's id.
 */
import { PREFERENCE_DEFAULTS, readPreferences, type Preferences } from '../shared/preferences';
import { database } from './db';

/** The person's preferences, with the defaults for whatever they never set. */
export function getPreferences(userId: string): Preferences {
  const row = database().get<{ data: string }>('SELECT data FROM user_preferences WHERE user_id = ?', userId);
  if (!row) return { ...PREFERENCE_DEFAULTS };
  try {
    return readPreferences(JSON.parse(row.data));
  } catch {
    return { ...PREFERENCE_DEFAULTS };
  }
}

/** Merge `patch` into the person's preferences and save; returns the result. */
export function setPreferences(userId: string, patch: Partial<Preferences>): Preferences {
  const db = database();
  return db.transaction(() => {
    const next = { ...getPreferences(userId), ...patch };
    db.upsert('user_preferences', { user_id: userId, data: JSON.stringify(next), updated_at: new Date().toISOString() });
    return next;
  });
}
