/** DELETE /api/settings/networks/:id/runners/:runnerId revokes a runner: its token is refused from its next check, within seconds (C29, FR-8). A built-in admin's. */
import { requireUser } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { revokeRunner } from '@/lib/server/networks/store';

export const dynamic = 'force-dynamic';

export const DELETE = handler(async (_request: Request, { params }: { params: Promise<{ id: string; runnerId: string }> }) => {
  const me = await requireUser('settings:manage');
  const { id, runnerId } = await params;
  return json({ runner: revokeRunner(id, runnerId, me) });
});
