import { getSettings, hostTimeZone, settingsPatchSchema, staleExecutionIds, updateSettings } from '@/lib/server/settings';
import { handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

/** The settings, the host's own zone, and how many stored executions the retention settings would remove now. */
function view() {
  const settings = getSettings();
  const executions = store.listExecutions({ limit: Number.POSITIVE_INFINITY });
  return { settings, hostTimezone: hostTimeZone(), executions: { stored: executions.length, prunable: staleExecutionIds(executions, settings.executions).length } };
}

export const GET = handler(async () => json(view()));

/** PATCH { timezone?, executions?: { maxCount?, maxAgeDays? } } — 0 turns a retention limit off. */
export const PATCH = handler(async (request: Request) => {
  const body = await parseBody(request, settingsPatchSchema);
  if (!body.ok) return body.response;
  updateSettings(body.data);
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'general', name: 'General' }, details: { fields: Object.keys(body.data), ...body.data } });
  return json(view());
});
