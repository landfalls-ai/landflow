/**
 * Audit events as OpenTelemetry log records, through the OTel logs API: with OTLP export configured, the host's log
 * provider (lib/server/telemetry/logs.ts) sends them to the same collector as the traces and metrics, so they show up
 * in any OTLP backend. Each record has `event.name` (`landflow.audit.<action>`, also as the record's eventName),
 * the summary as its body, and semantic attributes: `user.*`, `client.address`, `user_agent.original`,
 * `http.request.method`, `http.route`, `http.response.status_code`, plus `landflow.audit.*` for the rest.
 * The same event is also written to the process log (stdout JSON) for log shippers.
 */
import { logs, SeverityNumber, type Attributes } from '@opentelemetry/api';
import type { AuditEvent } from '../../shared/audit';
import { telemetryConfig } from '../telemetry/config';
import { logger } from '../telemetry/logger';

export const AUDIT_SCOPE = 'landflow.audit';

export const auditEventName = (action: string) => `${AUDIT_SCOPE}.${action}`;

/** The record's attributes: OTel semantic names where one exists, `landflow.audit.*` otherwise. */
export function auditAttributes(event: AuditEvent): Attributes {
  const attributes: Attributes = {
    'event.name': auditEventName(event.action),
    'landflow.audit.id': event.id,
    'landflow.audit.action': event.action,
    'landflow.audit.category': event.category,
    'landflow.audit.outcome': event.outcome,
    'landflow.audit.actor.type': event.actor.type,
    ...(event.actor.id && { 'user.id': event.actor.id }),
    ...(event.actor.name && { 'user.name': event.actor.name }),
    ...(event.actor.email && { 'user.email': event.actor.email }),
    ...(event.apiKeyId && { 'landflow.api_key.id': event.apiKeyId }),
    ...(event.ip && { 'client.address': event.ip }),
    ...(event.userAgent && { 'user_agent.original': event.userAgent }),
    ...(event.requestId && { 'landflow.request.id': event.requestId }),
    ...(event.method && { 'http.request.method': event.method }),
    ...(event.route && { 'http.route': event.route }),
    ...(event.status !== undefined && { 'http.response.status_code': event.status }),
    ...(event.target?.type && { 'landflow.audit.target.type': event.target.type }),
    ...(event.target?.id && { 'landflow.audit.target.id': event.target.id }),
    ...(event.target?.name && { 'landflow.audit.target.name': event.target.name }),
  };
  for (const [key, value] of Object.entries(event.details ?? {})) {
    if (value === null) continue;
    attributes[`landflow.audit.details.${key}`] = value;
  }
  return attributes;
}

/** Emit `event` as an OTel log record and a process log line. Never throws. */
export function emitAuditLog(event: AuditEvent) {
  try {
    const warn = event.outcome !== 'success';
    logs.getLogger(AUDIT_SCOPE, telemetryConfig.serviceVersion).emit({
      eventName: auditEventName(event.action),
      timestamp: new Date(event.at),
      severityNumber: warn ? SeverityNumber.WARN : SeverityNumber.INFO,
      severityText: warn ? 'WARN' : 'INFO',
      body: event.summary,
      attributes: auditAttributes(event),
    });
  } catch {
    // Telemetry never breaks the action being audited.
  }
  logger.info('audit', {
    'event.name': auditEventName(event.action),
    'landflow.audit.id': event.id,
    'landflow.audit.outcome': event.outcome,
    ...(event.actor.id && { 'user.id': event.actor.id }),
    ...(event.target?.type && { 'landflow.audit.target.type': event.target.type }),
    ...(event.target?.id && { 'landflow.audit.target.id': event.target.id }),
    summary: event.summary,
  });
}
