/**
 * GET /api/audit/head — the audit chain's newest signed head (lib/server/audit/signing.ts) and the public keys that signed:
 * `{ head, signedAt, anchoredAt, keys }`. `head.payload` is the exact JSON text that was signed (`seq`, `hash`, `signedAt`,
 * `keyId`), `head.signature` its Ed25519 signature (base64); `landflow audit verify --head` checks it offline against a public
 * key you pinned. `head` is null before the first signature (the leader signs on a schedule, or Settings → Audit log → Integrity →
 * Sign now). Owners and admins; API keys need the `audit:read` scope.
 */
import { latestHead, signingKeys } from '@/lib/server/audit/signing';
import { handler, json } from '@/lib/server/http';
import type { AuditHeadView } from '@/lib/shared/audit';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const latest = latestHead();
  const view: AuditHeadView = {
    head: latest?.head ?? null,
    ...(latest && { signedAt: latest.signedAt }),
    ...(latest?.anchoredAt && { anchoredAt: latest.anchoredAt }),
    keys: signingKeys(),
  };
  return json(view);
});
