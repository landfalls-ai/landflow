/**
 * C21: change who uses a collection a project owns (an admin of that project, or an owner or admin of the instance; every change is audited).
 * POST { grant: { projectId | '*', level: 'read' | 'write' } } — let another project, or every project, read or write it
 *      (also turns a "lost access" notice into a grant).
 * POST { revoke: projectId | '*' } — stop sharing, or dismiss a "lost access" notice.
 * POST { notionRead: boolean } — with `key` the project's own Notion knowledge collection: let its flows read it (FR-7).
 * `key` is the collection's key, URL-encoded (`sqlite:handbook`). Answers 200 `{ ok: true }`; 404 for a collection the project doesn't own.
 */
import { z } from 'zod';
import { COLLECTION_LEVELS, notionKeyOf } from '@/lib/shared/collections';
import { error, json, parseBody } from '@/lib/server/http';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { grantCollection, ownerProjectOf, revokeCollection, setNotionRead } from '@/lib/server/rag/collection-access';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; key: string }> };

const Body = z.union([
  z.object({ grant: z.object({ projectId: z.string().trim().min(1).max(100), level: z.enum(COLLECTION_LEVELS) }) }).strict(),
  z.object({ revoke: z.string().trim().min(1).max(100) }).strict(),
  z.object({ notionRead: z.boolean() }).strict(),
]);

export const POST = projectRoute(async (request: Request, { params }: Ctx) => {
  const { id, key } = await params;
  const actor = routeActor();
  const project = requireProject(actor, id, 'read');
  const body = await parseBody(request, Body);
  if (!body.ok) return body.response;
  if ('notionRead' in body.data) {
    if (key !== notionKeyOf(project.id)) return error('Collection not found', 404);
    setNotionRead(actor, project.id, body.data.notionRead);
    return json({ ok: true });
  }
  // The route's project must be the owner: a collection is managed from its owner's card only.
  if (ownerProjectOf(key) !== project.id) return error('Collection not found', 404);
  if ('grant' in body.data) grantCollection(actor, key, body.data.grant.projectId, body.data.grant.level);
  else revokeCollection(actor, key, body.data.revoke);
  return json({ ok: true });
});
