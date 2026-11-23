/**
 * POST /api/source-control/host-keys — `{ repository }`: the host keys the SSH server presents (ssh-keyscan) with their
 * SHA256 fingerprints and the `known_hosts` text to pin. Compare the fingerprints with the ones the server's owner
 * publishes before saving them in Settings → Source control.
 */
import { z } from 'zod';
import { handler, json, parseBody } from '@/lib/server/http';
import { scanHostKeys } from '@/lib/server/sync/git';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ repository: z.string().trim().min(1).max(2000) }));
  if (!body.ok) return body.response;
  return json(await scanHostKeys(body.data.repository));
});
