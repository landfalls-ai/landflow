/**
 * Who without a Landflow account may ask for access (docs/access-requests.md#signing-in-without-an-account). Instance admins only; session only.
 *
 * GET /api/access/outside → `{ enabled, domains, google: { enabled, credentialId?, credentialName? }, pageUrl, redirectUrl, mail }`.
 * PUT /api/access/outside `{ enabled?, domains?, google?: { enabled?, credentialId? } }` saves (audited with before and after); 400 names the
 * field: a domain that is a free mail provider or not a host name, no domain while switching on, Google without a usable OpenID Connect client.
 */
import { z } from 'zod';
import { outsideSettingsView, saveOutsideSettings } from '@/lib/server/access/outside/settings';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const bodySchema = z
  .object({
    enabled: z.boolean().optional(),
    domains: z.array(z.string().max(253)).max(200).optional(),
    google: z.object({ enabled: z.boolean().optional(), credentialId: z.string().min(1).max(100).nullable().optional() }).strict().optional(),
  })
  .strict();

export const GET = handler(async () => json(outsideSettingsView(routeActor())));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json(saveOutsideSettings(routeActor(), body.data));
});
