/**
 * GET  /api/composites — every composite type (docs/composites.md): the plugins' (core's included; `available` says
 *      whether the plugin is online) and the library saved on this instance (`local.<name>`). Each has its newest
 *      version as `descriptor`, every version number in `versions`, and every version's descriptor in `all` when
 *      there are several (frames pin a version).
 * POST /api/composites — save a type to the library: `{ descriptor }` (a CompositeTypeDescriptor; the editor's "Make
 *      composite type…" proposes one from a group). A name already saved gets the next version.
 */
import { z } from 'zod';
import { currentPrincipal } from '@/lib/server/auth/guard';
import { CompositeError, listCompositeTypes, saveLocalComposite } from '@/lib/server/composites';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ composites: listCompositeTypes() }));

const bodySchema = z.object({ descriptor: z.record(z.string(), z.unknown()) });

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  try {
    return json({ composite: saveLocalComposite(body.data.descriptor, currentPrincipal()?.user.id) }, 201);
  } catch (caught) {
    if (caught instanceof CompositeError) return error(caught.message, caught.status, caught.details ? { details: caught.details } : {});
    throw caught;
  }
});
