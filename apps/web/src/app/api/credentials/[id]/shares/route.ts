/**
 * GET /api/credentials/:id/shares — the credential's project and the projects it is shared with; PUT { shares:
 * [{ projectId | userId, role: user }] } replaces them (admins of its project, owners and admins). A share lets that
 * project's workflows use the credential in runs; nobody there can read its data.
 */
import { credentials } from '@/lib/server/credentials/vault';
import { shareRoutes } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

const routes = shareRoutes('credential', (id) => Boolean(credentials.get(id)));
export const GET = routes.GET;
export const PUT = routes.PUT;
