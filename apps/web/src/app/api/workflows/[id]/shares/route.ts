/**
 * GET /api/workflows/:id/shares — the workflow's project and who it is shared with; PUT { shares: [{ projectId |
 * userId, role: editor | viewer }] } replaces the shares (admins of its project, owners and admins).
 */
import { shareRoutes } from '@/lib/server/projects/http';
import { store } from '@/lib/server/store';

export const dynamic = 'force-dynamic';

const routes = shareRoutes('workflow', (id) => Boolean(store.getWorkflow(id)));
export const GET = routes.GET;
export const PUT = routes.PUT;
