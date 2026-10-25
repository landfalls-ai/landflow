/**
 * Settings → Source control: GET the settings and the last push and pull; PUT `{ repository, branch?, directory?,
 * credentialId?, username?, authorName?, authorEmail?, includeVariableValues? }` saves them; DELETE disconnects
 * (forgets the settings and removes the working copy; the repository is untouched).
 */
import { error, handler, json, parseBody } from '@/lib/server/http';
import { configureSourceControl, disconnectSourceControl, SourceControlError, sourceControlInputSchema, sourceControlView } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(sourceControlView()));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, sourceControlInputSchema);
  if (!body.ok) return body.response;
  try {
    return json(configureSourceControl(body.data));
  } catch (caught) {
    if (caught instanceof SourceControlError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async () => json(disconnectSourceControl()));
