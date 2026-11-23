/**
 * Access requests setup (docs/access-requests.md#setting-up).
 *
 * GET  /api/access/setup → `{ installed, active, workflowId?, chatWorkflowId?, projectId?, mail }`.
 * POST /api/access/setup `{ projectId?, modelCredentialId? }` (admins) installs and publishes the request flow and the chat flow once,
 * and answers the setup; a second POST answers the existing one. Session only.
 */
import { z } from 'zod';
import { accessSetup, installAccessRequests } from '@/lib/server/access/setup';
import { handler, json, parseBody } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const bodySchema = z.object({ projectId: z.string().min(1).max(100).optional(), modelCredentialId: z.string().min(1).max(100).optional() });

export const GET = handler(async () => json(accessSetup()));

export const POST = handler(async (request: Request) => {
  const text = await request.clone().text();
  if (!text.trim()) return json(await installAccessRequests(routeActor(), {}));
  const body = await parseBody(request, bodySchema);
  if (!body.ok) return body.response;
  return json(await installAccessRequests(routeActor(), body.data));
});
