import { getSettings, hostTimeZone, jsonRenderOn, settingsPatchSchema, staleExecutionIds, updateSettings } from '@/lib/server/settings';
import { requireUser } from '@/lib/server/auth';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

/** The settings, `jsonRender` (the json-render flag as it stands, saved setting or environment default), the host's own zone, and how many stored executions the retention settings would remove now. */
function view() {
  const settings = getSettings();
  const executions = store.listExecutions({ limit: Number.POSITIVE_INFINITY });
  return { settings, jsonRender: jsonRenderOn(), hostTimezone: hostTimeZone(), executions: { stored: executions.length, prunable: staleExecutionIds(executions, settings.executions).length } };
}

export const GET = handler(async () => json(view()));

/** PATCH { timezone?, executions?: { maxCount?, maxAgeDays? }, jsonRender?: boolean | null } — 0 turns a retention limit off; jsonRender is the owner's (null: back to the environment default). */
export const PATCH = handler(async (request: Request) => {
  const body = await parseBody(request, settingsPatchSchema);
  if (!body.ok) return body.response;
  if (body.data.jsonRender !== undefined && (await requireUser()).role !== 'owner') return error('Only the owner can switch json-render', 403);
  updateSettings(body.data);
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'general', name: 'General' }, details: { fields: Object.keys(body.data), ...body.data } });
  return json(view());
});
