/**
 * GET /api/settings/audit — audit settings (retention, credential use), the SIEM destinations with their outbox, OTLP
 * log export and how many events are stored. PATCH `{ retentionDays?, credentialUse? }` changes the settings.
 * Owners and admins.
 */
import type { AuditSettingsView } from '@/lib/shared/audit';
import { auditedTransaction, recordAudit } from '@/lib/server/audit';
import { auditDestinations } from '@/lib/server/audit/destinations';
import { pruneAuditLog } from '@/lib/server/audit/outbox';
import { auditSettingsPatchSchema, getAuditSettings, updateAuditSettings } from '@/lib/server/audit/settings';
import { countEvents } from '@/lib/server/audit/store';
import { handler, json, parseBody } from '@/lib/server/http';
import { telemetryConfig } from '@/lib/server/telemetry/config';
import { otlpLogsEndpoint } from '@/lib/server/telemetry/logs';

export const dynamic = 'force-dynamic';

function settingsView(): AuditSettingsView {
  return {
    settings: getAuditSettings(),
    destinations: auditDestinations.list(),
    otlp: { enabled: telemetryConfig.exportLogs && !telemetryConfig.disabled, ...(telemetryConfig.exportLogs && { endpoint: otlpLogsEndpoint() }) },
    stored: countEvents(),
  };
}

export const GET = handler(async () => json(settingsView()));

export const PATCH = handler(async (request: Request) => {
  const body = await parseBody(request, auditSettingsPatchSchema);
  if (!body.ok) return body.response;
  const before = getAuditSettings();
  const after = auditedTransaction(() => {
    const next = updateAuditSettings(body.data);
    recordAudit({ action: 'settings.update', target: { type: 'settings', id: 'audit', name: 'Audit log' }, details: { retentionDays: next.retentionDays, credentialUse: next.credentialUse, ...(before.retentionDays !== next.retentionDays && { previousRetentionDays: before.retentionDays }) } });
    return next;
  });
  if (after.retentionDays && after.retentionDays < before.retentionDays) await pruneAuditLog();
  return json(settingsView());
});
