/**
 * PATCH /api/settings/audit/destinations/:id `{ name?, enabled?, config? }` — change a SIEM destination (empty
 * secret fields keep their saved value). DELETE removes it and drops what is still queued for it. Owners and admins.
 */
import { recordAudit } from '@/lib/server/audit';
import { AuditDestinationError, auditDestinations, destinationPatchSchema } from '@/lib/server/audit/destinations';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const { id } = await params;
  const body = await parseBody(request, destinationPatchSchema);
  if (!body.ok) return body.response;
  try {
    const destination = auditDestinations.update(id, body.data);
    recordAudit({ action: 'settings.update', target: { type: 'audit_destination', id, name: destination.name }, summary: `Changed the audit destination “${destination.name}”`, details: { kind: destination.kind, enabled: destination.enabled, fields: Object.keys(body.data.config ?? {}).join(',') || undefined } });
    return json({ destination });
  } catch (caught) {
    if (caught instanceof AuditDestinationError) return error(caught.message, caught.status);
    throw caught;
  }
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) => {
  const { id } = await params;
  const existing = auditDestinations.get(id);
  if (!existing || !auditDestinations.remove(id)) return error('Audit destination not found', 404);
  recordAudit({ action: 'settings.update', target: { type: 'audit_destination', id, name: existing.name }, summary: `Removed the audit destination “${existing.name}”`, details: { kind: existing.kind, dropped: existing.pending } });
  return json({ ok: true });
});
