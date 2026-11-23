/**
 * The requester's own accounts for access requests (docs/access-requests.md#outside-requesters-what-they-can-ask-and-see). Needs the requester session.
 *
 * GET /request-access/api/account → `{ github?, google? }`: the GitHub username kept for them (typed, unverified, unique across everyone), and their
 *   verified email (Google access always goes to it; not editable).
 * PUT /request-access/api/account `{ github }` → the same; audited (`access.account.set`). 409 when another person has that username.
 */
import { z } from 'zod';
import { accountsOf, setGithubAccount } from '@/lib/server/access/requests';
import { outsideRoute } from '@/lib/server/access/outside/http';
import { json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = outsideRoute(async ({ requester }) => json(accountsOf(requester)));

export const PUT = outsideRoute(
  async ({ req, requester }) => {
    const body = await parseBody(req, z.object({ github: z.string().max(100) }));
    if (!body.ok) return body.response;
    return json(setGithubAccount(requester, body.data.github));
  },
  { write: true },
);
