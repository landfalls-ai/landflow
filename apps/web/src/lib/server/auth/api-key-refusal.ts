/** What a refused API key is told (never the list, never the key). Kept apart from ./api-key-audit so the guard can import it without a cycle through the audit layer. */
export type KeyRefusal = 'ip_not_allowed' | 'uses_exhausted';

export const KEY_REFUSAL_MESSAGE: Record<KeyRefusal, string> = {
  ip_not_allowed: 'This API key can’t be used from this address',
  uses_exhausted: 'This API key has used all its uses',
};
