/**
 * POST /api/workflows/:id/transfer { projectId, shareCredentials? } — move the workflow to another project (admins of
 * its project, who must be editors of the target). `shareCredentials` also shares the credentials it uses (those the
 * caller may share) with the new project, so its runs keep working.
 */
import { transferRoute } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

export const POST = transferRoute(
  'workflow',
  (id) => Boolean(store.getWorkflow(id)),
  (id) => [...new Set((store.getWorkflow(id)?.nodes ?? []).flatMap((node) => Object.values(node.credentials ?? {}).map((ref) => ref.id)))],
);
