import { alertsView, ruleCreateSchema, withAlertErrors } from '@/lib/server/alerts/api';
import { alertStore } from '@/lib/server/alerts/store';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** POST { name, workflows, events, channelIds, throttleMinutes?, waitingMinutes?, includeManual?, enabled? } — a new rule. */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, ruleCreateSchema);
  if (!body.ok) return body.response;
  return withAlertErrors(() => json({ rule: alertStore.createRule(body.data), ...alertsView() }, 201));
});
