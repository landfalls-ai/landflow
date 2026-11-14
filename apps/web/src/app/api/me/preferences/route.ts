import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { getPreferences, setPreferences } from '@/lib/server/preferences';
import { preferencesPatchSchema } from '@/lib/shared/preferences';

export const dynamic = 'force-dynamic';

/**
 * The signed-in person's own preferences (session only: policy.ts). Changing a preference records nothing in the audit
 * log: it is the person's own setting, not a security-relevant change.
 */
export const GET = handler(async () => json({ preferences: getPreferences(routeActor().id) }));

/** PATCH { developerDetails?, keepConversations?, briefingDelivery? }: a bad value is a 400, an unknown key is dropped. */
export const PATCH = handler(async (request: Request) => {
  const body = await parseBody(request, preferencesPatchSchema);
  if (!body.ok) return body.response;
  return json({ preferences: setPreferences(routeActor().id, body.data) });
});
