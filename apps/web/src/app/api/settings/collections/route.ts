/**
 * C21: every vector collection on the instance (owners and admins only).
 * GET — `{ collections: [...], adoption, projects }`: each claimed collection with its owner, source and grants, the report of the
 * one-time adoption at the upgrade (`{ at, collections, lost: [{ key, projectId }], unresolved }`) and the projects.
 * POST { adopt: true } — look for owners again (what is already owned is kept; the report is answered).
 * POST { transfer: { key, projectId } } — move a collection to another project (audited).
 */
import { z } from 'zod';
import { json, parseBody } from '@/lib/server/http';
import { projectRoute, routeActor } from '@/lib/server/projects/http';
import { adoptAgain, allCollections, transferCollection } from '@/lib/server/rag/collection-access';

export const dynamic = 'force-dynamic';

export const GET = projectRoute(async () => json(allCollections(routeActor())));

const Body = z.union([z.object({ adopt: z.literal(true) }).strict(), z.object({ transfer: z.object({ key: z.string().trim().min(1).max(400), projectId: z.string().trim().min(1).max(100) }) }).strict()]);

export const POST = projectRoute(async (request: Request) => {
  const body = await parseBody(request, Body);
  if (!body.ok) return body.response;
  const actor = routeActor();
  if ('adopt' in body.data) return json({ adoption: adoptAgain(actor) });
  transferCollection(actor, body.data.transfer.key, body.data.transfer.projectId);
  return json({ ok: true });
});
