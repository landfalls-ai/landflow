/**
 * Settings → Source control: GET the settings and the last push and pull; PUT `{ repository, branch?, directory?,
 * credentialId?, username?, authorName?, authorEmail?, includeVariableValues? }` saves them; DELETE disconnects
 * (forgets the settings and removes the working copy; the repository is untouched).
 */
import { error, handler, json, parseBody } from '@/lib/server/http';
import { configureSourceControl, disconnectSourceControl, SourceControlError, sourceControlInputSchema, sourceControlView } from '@/lib/server/sync/git';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(sourceControlView()));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, sourceControlInputSchema);
  if (!body.ok) return body.response;
  try {
    const view = configureSourceControl(body.data);
    recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'source-control', name: 'Source control' }, summary: 'Changed the source control settings' });
    return json(view);
  } catch (caught) {
    if (caught instanceof SourceControlError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async () => {
  const view = disconnectSourceControl();
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'source-control', name: 'Source control' }, summary: 'Disconnected source control' });
  return json(view);
});
