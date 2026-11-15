/**
 * Settings → AI → LLM gateway (docs/llm-gateway.md): which gateway credential is the instance's, the cluster and UI
 * addresses, the switches and the headroom.
 *
 * GET → LlmGatewaySettingsView (no key, ever); PUT { credentialId?, clusterUrl?, uiUrl?, portalHeaders?, ingest?, sync?,
 * headroomPercent? } → the view. Turning `sync` on runs one sync in the background. Admins change it (the settings policy).
 */
import { recordAudit } from '@/lib/server/audit';
import { handler, json, parseBody } from '@/lib/server/http';
import { gatewaySettings, gatewaySettingsView, llmGatewaySettingsSchema, saveGatewaySettings } from '@/lib/server/llm-gateway/settings';
import { syncBudgets } from '@/lib/server/llm-gateway/sync';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(gatewaySettingsView()));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, llmGatewaySettingsSchema);
  if (!body.ok) return body.response;
  const wasOn = gatewaySettings().sync;
  saveGatewaySettings(body.data);
  recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'llm-gateway', name: 'LLM gateway' }, details: { fields: Object.keys(body.data) } });
  if (!wasOn && gatewaySettings().sync) void syncBudgets({ trigger: 'manual' });
  return json(gatewaySettingsView());
});
