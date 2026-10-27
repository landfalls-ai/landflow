/**
 * POST /api/settings/audit/anchoring/rotate-key — start a new Ed25519 signing key for the chain's head. The old key is retired but
 * stays in `GET /api/audit/head`'s `keys`, so heads it signed still verify. Pin the new public key wherever you verify. Owners and admins.
 */
import { recordAudit } from '@/lib/server/audit';
import { rotateSigningKey } from '@/lib/server/audit/signing';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  const key = rotateSigningKey();
  recordAudit({ action: 'settings.update', target: { type: 'audit_log' }, summary: `Rotated the audit head signing key (now ${key.keyId})`, details: { keyId: key.keyId } });
  return json({ key }, 201);
});
