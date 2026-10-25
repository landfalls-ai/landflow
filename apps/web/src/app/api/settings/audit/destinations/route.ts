/**
 * POST /api/settings/audit/destinations `{ name, kind: syslog | http | splunk, enabled?, config }` — add a SIEM
 * destination (see lib/server/audit/destinations.ts for the settings of each kind; secrets never come back). New
 * audit events are queued for it from now on. Owners and admins.
 */
import { recordAudit } from '@/lib/server/audit';
import { AuditDestinationError, auditDestinations, destinationCreateSchema } from '@/lib/server/audit/destinations';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ destinations: auditDestinations.list() }));

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, destinationCreateSchema);
  if (!body.ok) return body.response;
  try {
    const destination = auditDestinations.create(body.data);
    recordAudit({ action: 'settings.update', target: { type: 'audit_destination', id: destination.id, name: destination.name }, summary: `Added the audit destination “${destination.name}”`, details: { kind: destination.kind, enabled: destination.enabled } });
    return json({ destination }, 201);
  } catch (caught) {
    if (caught instanceof AuditDestinationError) return error(caught.message, caught.status);
    throw caught;
  }
});
