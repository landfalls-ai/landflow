/**
 * GET /request-access/api/entries → `{ items }`: the entries an admin opened to outside requesters (name, description, target label,
 * durations, whether a GitHub username is needed), never approvers, owners, credentials or the entries that stay closed. Needs the
 * requester session (docs/access-requests.md#outside-requesters-what-they-can-ask-and-see).
 */
import { accessBackend } from '@/lib/server/access/port';
import { outsideRoute } from '@/lib/server/access/outside/http';
import { json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = outsideRoute(async () => json({ items: accessBackend().catalog.listOpenToOutside() }));
