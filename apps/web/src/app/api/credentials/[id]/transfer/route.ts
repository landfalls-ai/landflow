/**
 * POST /api/credentials/:id/transfer { projectId, keepAccess? } — move the credential to another project (admins of
 * its project, who must be editors of the target). Unless `keepAccess: false`, the project it leaves keeps using it
 * (a share), so its workflows' runs don't break.
 */
import { credentials } from '@/lib/server/credentials/vault';
import { transferRoute } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = transferRoute('credential', (id) => Boolean(credentials.get(id)));
