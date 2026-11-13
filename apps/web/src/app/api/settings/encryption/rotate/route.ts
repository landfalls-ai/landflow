/**
 * POST /api/settings/encryption/rotate — re-seal every stored secret (credentials, alert channels, signing keys, …) with
 * the primary key of the ring (LANDFLOW_ENCRYPTION_KEYS). Owner only, session only. Refused while no ring is configured
 * (the primary would be the one key already in use). Idempotent: run it again after an interruption. In queue mode every
 * process must have the new ring first (docs/features/secrets-and-environments.md). The answer says what was re-sealed
 * and what could not be opened; remove an old key only when `failed` is empty.
 */
import { recordAudit } from '@/lib/server/audit';
import { requireUser } from '@/lib/server/auth';
import { credentials } from '@/lib/server/credentials/vault';
import { rotateEncryption } from '@/lib/server/credentials/rotate';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  const user = await requireUser();
  if (user.role !== 'owner') return error('Only the owner can rotate the encryption key', 403);
  if (!credentials.ringConfigured) return error('Set LANDFLOW_ENCRYPTION_KEYS (kid:key, the new key first) on every process before rotating', 409);
  const result = rotateEncryption();
  recordAudit({
    action: 'encryption.rotate',
    target: { type: 'settings', id: 'encryption', name: 'Encryption key' },
    details: { primary: result.primary, resealed: result.resealed, current: result.current, failed: result.failed.length, stores: result.stores },
  });
  return json({ ...result, done: result.failed.length === 0 });
});
