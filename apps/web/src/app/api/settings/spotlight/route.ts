/**
 * Settings → AI → Spotlight (docs/assistant.md): the model Spotlight uses unless a person picks another in its header.
 *
 * GET → { default, models } (any reader); PUT { model } → the same (admins, the settings policy). A model the server
 * does not offer is refused with 400. The list comes only from the server's configuration (models-list.ts).
 */
import { z } from 'zod';
import { recordAudit } from '@/lib/server/audit';
import { effectiveSpotlightDefault, saveSpotlightDefault, spotlightModels } from '@/lib/server/assistant/models-list';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const Body = z.object({ model: z.string().trim().min(1).max(200) });

const view = async () => json({ default: await effectiveSpotlightDefault(), models: await spotlightModels() });

export const GET = handler(async () => view());

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, Body);
  if (!body.ok) return body.response;
  const saved = await saveSpotlightDefault(body.data.model);
  if (!saved.ok) return error(saved.error, 400);
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'spotlight', name: 'Spotlight model' }, details: { model: body.data.model } });
  return view();
});
