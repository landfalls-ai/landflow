/**
 * GET/PUT /api/settings/audit/anchoring — how often the audit chain's head is signed and where the signed heads are anchored
 * (an S3 bucket, a webhook): lib/server/audit/anchoring.ts. Secrets (the S3 secret key, the webhook secret) never come back
 * (`secretsSet`); a PUT that leaves one empty keeps it, and `null` for `s3` or `webhook` removes the target. Owners and admins.
 */
import { recordAudit } from '@/lib/server/audit';
import { AnchoringError, anchoringPatchSchema, anchoringView, updateAnchoring } from '@/lib/server/audit/anchoring';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(anchoringView()));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, anchoringPatchSchema);
  if (!body.ok) return body.response;
  try {
    const view = updateAnchoring(body.data);
    recordAudit({
      action: 'settings.update',
      target: { type: 'audit_log' },
      summary: 'Changed the audit log’s head signing and anchoring settings',
      details: { enabled: view.settings.enabled, intervalMinutes: view.settings.intervalMinutes, s3: Boolean(view.settings.s3), webhook: Boolean(view.settings.webhook) },
    });
    return json(view);
  } catch (caught) {
    if (caught instanceof AnchoringError) return error(caught.message, caught.status);
    throw caught;
  }
});
