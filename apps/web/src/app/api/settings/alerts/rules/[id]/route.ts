import { alertsView, rulePatchSchema, withAlertErrors } from '@/lib/server/alerts/api';
import { alertStore } from '@/lib/server/alerts/store';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** PATCH: change any of a rule's fields (enabled to switch it off). */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, rulePatchSchema);
  if (!body.ok) return body.response;
  const { id } = await params;
  return withAlertErrors(() => json({ rule: alertStore.updateRule(id, body.data), ...alertsView() }));
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  if (!alertStore.deleteRule((await params).id)) return error('Alert rule not found', 404);
  return json(alertsView());
});
