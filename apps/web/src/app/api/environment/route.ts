/**
 * The instance's environment (LANDFLOW_ENVIRONMENT): GET the view (name, protection, branches, publish on pull,
 * credential mappings) the shell badge and Settings → Environments show; PUT `{ protected?, branches?,
 * environments?, publishOnPull?, credentialMap? }` changes the settings (the fields given).
 */
import { environmentSettingsSchema, environmentView, EnvironmentError, saveEnvironmentSettings } from '@/lib/server/environments';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(environmentView()));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, environmentSettingsSchema);
  if (!body.ok) return body.response;
  try {
    return json(saveEnvironmentSettings(body.data));
  } catch (caught) {
    if (caught instanceof EnvironmentError) return error(caught.message, caught.status);
    throw caught;
  }
});
