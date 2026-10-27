/**
 * POST /api/settings/audit/anchoring/run — sign the audit chain's head now (after checking the whole chain) and copy the signed
 * heads that aren't anchored yet to the S3 bucket and webhook, if any. Answers the head and what the anchoring did; 409 when the
 * chain is broken (nothing is signed) or has no events. Audited as `audit.sign_head`. Owners and admins.
 */
import { recordAudit } from '@/lib/server/audit';
import { signAndAnchor } from '@/lib/server/audit/anchoring';
import { AuditSigningError } from '@/lib/server/audit/signing';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  try {
    const { record, created, anchor } = await signAndAnchor();
    const failure = anchor.failed ? record.anchorError : undefined;
    recordAudit({
      action: 'audit.sign_head',
      outcome: anchor.failed ? 'failure' : 'success',
      target: { type: 'audit_log' },
      summary: `Signed the audit chain’s head at #${record.seq}${anchor.anchored ? ` and anchored ${anchor.anchored} head${anchor.anchored === 1 ? '' : 's'}` : ''}${failure ? `; anchoring failed: ${failure}` : ''}`,
      details: { seq: record.seq, keyId: record.head.keyId, created, anchored: anchor.anchored, anchorFailed: anchor.failed, targets: anchor.targets },
    });
    return json({ head: record.head, signedAt: record.signedAt, created, anchored: Boolean(record.anchoredAt), anchoredAt: record.anchoredAt ?? null, anchorError: record.anchorError ?? null, anchor });
  } catch (caught) {
    if (caught instanceof AuditSigningError) {
      recordAudit({ action: 'audit.sign_head', outcome: 'failure', target: { type: 'audit_log' }, summary: `Did not sign the audit chain’s head: ${caught.message}`, details: { reason: caught.message.slice(0, 300) } });
      return error(caught.message, caught.status);
    }
    throw caught;
  }
});
