'use client';
/**
 * The signed-in person's preferences (lib/shared/preferences.ts), kept on the server so they follow the person. The last
 * answer is cached in localStorage (`landflow-preferences`) so the first paint already has it; the page then asks the
 * server (`background: true`, so it isn't use of the session) and the server wins. A change shows at once, is saved with
 * PATCH, and is put back if the save fails.
 */
import { useSyncExternalStore } from 'react';
import { PREFERENCE_DEFAULTS, readPreferences, type PreferenceKey, type Preferences } from '../shared/preferences';
import { api } from './api';

export const PREFERENCES_CACHE_KEY = 'landflow-preferences';

let current: Preferences = PREFERENCE_DEFAULTS;
let loaded = false;
const listeners = new Set<() => void>();

function readCache(): Preferences {
  try {
    const text = localStorage.getItem(PREFERENCES_CACHE_KEY);
    return text ? readPreferences(JSON.parse(text)) : PREFERENCE_DEFAULTS;
  } catch {
    return PREFERENCE_DEFAULTS;
  }
}

function publish(next: Preferences) {
  const same = (Object.keys(next) as PreferenceKey[]).every((key) => next[key] === current[key]);
  if (same) return;
  current = next;
  try {
    localStorage.setItem(PREFERENCES_CACHE_KEY, JSON.stringify(next));
  } catch {}
  for (const listener of listeners) listener();
}

/** Forget the cached preferences (at sign-out: the cache is per browser, not per person). */
export function clearPreferencesCache() {
  try {
    localStorage.removeItem(PREFERENCES_CACHE_KEY);
  } catch {}
  current = PREFERENCE_DEFAULTS;
  loaded = false;
}

/** Ask the server once per page load; the answer replaces the cache. */
function load() {
  if (loaded || typeof window === 'undefined') return;
  loaded = true;
  current = readCache();
  api<{ preferences: Preferences }>('/api/me/preferences', { background: true })
    .then((body) => publish(readPreferences(body.preferences)))
    .catch(() => {
      loaded = false;
    });
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // One window listener for all subscribers, added with the first and removed with the last.
  if (listeners.size === 1) window.addEventListener('storage', onStorage);
  load();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener('storage', onStorage);
  };
}

/** Another tab changed the cache. */
function onStorage(event: StorageEvent) {
  if (event.key === PREFERENCES_CACHE_KEY) publish(readCache());
}

/** All of the person's preferences. */
export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, () => current, () => PREFERENCE_DEFAULTS);
}

/** One preference. */
export function usePreference<K extends PreferenceKey>(key: K): Preferences[K] {
  return usePreferences()[key];
}

/** Change a preference: shown at once, saved to the server, put back (and the error thrown) if the save fails. */
export async function setPreference<K extends PreferenceKey>(key: K, value: Preferences[K]): Promise<void> {
  const before = current[key];
  publish({ ...current, [key]: value });
  try {
    const body = await api<{ preferences: Preferences }>('/api/me/preferences', { method: 'PATCH', json: { [key]: value } });
    publish(readPreferences(body.preferences));
  } catch (caught) {
    publish({ ...current, [key]: before });
    throw caught;
  }
}
