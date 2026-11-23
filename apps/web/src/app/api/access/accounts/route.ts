/**
 * The caller's own accounts for access requests (docs/access-requests.md#accounts).
 *
 * GET /api/access/accounts → `{ github?: string, google?: string }`: the GitHub username kept for them, and their Landflow email (Google access
 *   always goes to it; it is not editable).
 * PUT /api/access/accounts `{ github }` → the accounts. Only the caller changes their own; each change is audited (`access.account.set`).
 */
import { z } from 'zod';
import { accountsOf, setGithubAccount } from '@/lib/server/access/requests';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json(accountsOf(routeActor())));

export const PUT = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ github: z.string().max(100) }));
  if (!body.ok) return body.response;
  return json(setGithubAccount(routeActor(), body.data.github));
});
