/**
 * POST /api/workflows/:id/transfer { projectId, shareCredentials?, folderId? } — move the workflow to another project
 * (admins of its project, who must be editors of the target). `shareCredentials` also shares the credentials it uses
 * (those the caller may share) with the new project, so its runs keep working. Its folder belongs to the old project,
 * so it lands in `folderId` (a folder of the new project) or at the new project's top level.
 */
import { folders } from '@/lib/server/folders';
import { folderProblem } from '@/lib/server/projects/folders';
import { transferRoute } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const POST = transferRoute(
  'workflow',
  (id) => Boolean(store.getWorkflow(id)),
  (id) => [...new Set((store.getWorkflow(id)?.nodes ?? []).flatMap((node) => Object.values(node.credentials ?? {}).map((ref) => ref.id)))],
  {
    check: (_id, projectId, body) => (body.folderId ? folderProblem(body.folderId, projectId) : undefined),
    moved: (id, projectId, body) => {
      const workflow = store.getWorkflow(id);
      if (!workflow) return;
      // Without a folder asked for, it keeps a folder that is the new project's (a move to where it already is).
      const next = body.folderId === undefined && workflow.folderId && folders.projectOf(workflow.folderId) === projectId ? workflow.folderId : (body.folderId ?? undefined);
      if ((workflow.folderId ?? undefined) !== next) {
        const { folderId: _old, ...rest } = workflow;
        store.saveWorkflow(next ? { ...rest, folderId: next } : rest);
      }
      return { folderId: next ?? null };
    },
  },
);
