/**
 * GET /api/external-secrets/leases → `{ leases, nextCursor?, counts }`: the leased dynamic secrets (C30) issued to runs,
 * newest first, for Settings → External secrets → Leases. `?state=active|ended|revoke_failed`, `?executionId=`, `?limit=`
 * and `?cursor=`. Owners and admins only (`settings:manage`). A lease is shown by run, provider, path and times, never
 * by its lease id or its values.
 */
import { z } from 'zod';
import type { SecretLeasesResponse } from '@/lib/shared/secrets';
import { requireUser } from '@/lib/server/auth';
import { handler, json, parseQuery } from '@/lib/server/http';
import { decodeCursor, limitParam } from '@/lib/server/pagination';
import { leaseCounts, listLeases } from '@/lib/server/secrets/leases';

export const dynamic = 'force-dynamic';

const query = z.object({
  state: z.enum(['active', 'ended', 'revoke_failed']).optional(),
  executionId: z.string().min(1).max(200).optional(),
  limit: limitParam(),
  cursor: z
    .string()
    .max(512)
    .refine((text) => decodeCursor(text) !== undefined, 'Not a cursor from this API')
    .optional(),
});

export const GET = handler(async (request: Request) => {
  await requireUser('settings:manage');
  const parsed = parseQuery(request, query);
  if (!parsed.ok) return parsed.response;
  const body: SecretLeasesResponse = { ...listLeases(parsed.data), counts: leaseCounts() };
  return json(body);
});
