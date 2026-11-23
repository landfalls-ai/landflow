/**
 * POST /api/external-secrets/leases/revoke: end leased secrets now (C30). Body `{ id }` revokes one lease, `{ executionId }`
 * every open lease of a run, `{ id, dismiss: true }` sets a lease whose revoke was given up aside (its banner goes). Answers
 * `{ revoked, failed, leases }`: a store that refuses leaves the lease active with the reason in `lastError`, and
 * `failed` counts it. Owners and admins only; each revoke is audited with the person who asked.
 */
import { z } from 'zod';
import type { SecretLeaseRevokeResponse } from '@/lib/shared/secrets';
import { requireUser } from '@/lib/server/auth';
import { handler, json, parseBody } from '@/lib/server/http';
import { dismissLease, listLeases, revokeOne, revokeRun } from '@/lib/server/secrets/leases';

export const dynamic = 'force-dynamic';

const body = z.union([z.strictObject({ id: z.string().min(1).max(200), dismiss: z.boolean().optional() }), z.strictObject({ executionId: z.string().min(1).max(200) })]);

export const POST = handler(async (request: Request) => {
  await requireUser('settings:manage');
  const parsed = await parseBody(request, body);
  if (!parsed.ok) return parsed.response;
  if ('executionId' in parsed.data) {
    const tally = await revokeRun(parsed.data.executionId, 'admin');
    const response: SecretLeaseRevokeResponse = { ...tally, leases: listLeases({ executionId: parsed.data.executionId, limit: 500 }).leases };
    return json(response);
  }
  if (parsed.data.dismiss) {
    const response: SecretLeaseRevokeResponse = { revoked: 0, failed: 0, leases: [await dismissLease(parsed.data.id)] };
    return json(response);
  }
  const { lease, outcome } = await revokeOne(parsed.data.id, 'admin');
  const response: SecretLeaseRevokeResponse = { revoked: outcome === 'revoked' || outcome === 'expired' ? 1 : 0, failed: outcome === 'failed' ? 1 : 0, leases: [lease] };
  return json(response);
});
