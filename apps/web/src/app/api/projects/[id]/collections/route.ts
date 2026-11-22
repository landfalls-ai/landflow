/**
 * C21: the vector collections a project owns or may use.
 * GET — `{ collections: [{ key, store, name, access: 'owner' | 'read' | 'write', ownerProjectId, ownerName, source, grants?, lostAccess? }],
 * lost: [{ key, store, name, ownerProjectId, ownerName }], canManage, notion }` for any member. The owner's admins also see who else
 * has a grant and which projects lost access in the upgrade; `lost` is what this project named before the upgrade and no longer
 * reaches; `notion` (when the project has a Notion link) says whether its own flows may read its Notion knowledge.
 * GET ?check=<name>&store=sqlite|memory — `{ usable: boolean, message? }`: whether this project's agents and flows may use that
 * collection name (the knowledge dialog asks before saving). It says no for a name another project owns and for the brain's names,
 * the same words a run would give; it never says which project owns it.
 */
import { isBrainCollection } from '@/lib/shared/brain';
import { storeKeyOf } from '@/lib/shared/collections';
import { CollectionAccessError } from '@/lib/server/rag/collection-access';
import { json } from '@/lib/server/http';
import { activeLinkOf } from '@/lib/server/brain/notion/knowledge';
import { projectRoute, requireProject, routeActor } from '@/lib/server/projects/http';
import { canReadCollection, notionReadOn, projectCollections } from '@/lib/server/rag/collection-access';
import { notionKnowledgeCollection } from '@/lib/shared/notion-brain';
import { projectRoleCan } from '@/lib/shared/projects';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = projectRoute(async (request: Request, { params }: Ctx) => {
  const project = requireProject(routeActor(), (await params).id, 'read');
  const url = new URL(request.url);
  const check = url.searchParams.get('check')?.trim();
  if (check) {
    const store = url.searchParams.get('store') === 'memory' ? 'memory' : 'sqlite';
    if (isBrainCollection(check)) return json({ usable: false, message: `“${check}” is the second brain’s own collection` });
    return json(canReadCollection(storeKeyOf(store, check), project.id) ? { usable: true } : { usable: false, message: new CollectionAccessError(check, 'project').message });
  }
  const canManage = projectRoleCan.manage(project.role);
  const view = projectCollections(project.id, canManage);
  return json({ ...view, notion: activeLinkOf(project.id) ? { collection: notionKnowledgeCollection(project.id), read: notionReadOn(project.id) } : null });
});
