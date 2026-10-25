/**
 * A workflow's "Notify on failure" (its Settings dialog): one alert rule scoped to the workflow, managed by whoever
 * may edit the workflow. The channels themselves are set up by admins in Settings → Alerts.
 */
import { DEFAULT_THROTTLE_MINUTES } from '@/lib/shared/alerts';
import { withAlertErrors, workflowAlertSchema, workflowAlertView } from '@/lib/server/alerts/api';
import { alertStore } from '@/lib/server/alerts/store';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** GET: the workflow's rule (if any) and the channels to choose from. */
export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  if (!store.getWorkflow(id)) return error('Workflow not found', 404);
  return json(workflowAlertView(id));
});

/** PUT { channelIds, events?, throttleMinutes? } — turn the alert on (or change it). */
export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const workflow = store.getWorkflow(id);
  if (!workflow) return error('Workflow not found', 404);
  const body = await parseBody(request, workflowAlertSchema);
  if (!body.ok) return body.response;
  return withAlertErrors(() => {
    const current = alertStore.shortcutRule(id);
    const fields = {
      name: `Notify on failure: ${workflow.name}`,
      enabled: true,
      workflows: { mode: 'ids' as const, ids: [id] },
      events: body.data.events ?? current?.events ?? ['failed' as const],
      channelIds: body.data.channelIds,
      throttleMinutes: body.data.throttleMinutes ?? current?.throttleMinutes ?? DEFAULT_THROTTLE_MINUTES,
      shortcutFor: id,
    };
    if (current) alertStore.updateRule(current.id, fields);
    else alertStore.createRule(fields);
    return json(workflowAlertView(id));
  });
});

/** DELETE: turn it off (the rule goes). */
export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const current = alertStore.shortcutRule(id);
  if (current) alertStore.deleteRule(current.id);
  return json(workflowAlertView(id));
});
