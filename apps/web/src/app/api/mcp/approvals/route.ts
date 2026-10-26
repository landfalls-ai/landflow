/** MCP tool calls waiting for a person (lib/server/mcp/approvals.ts): the ones the signed-in user may answer, pending first. */
import { requireUser } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { listApprovals } from '@/lib/server/mcp/approvals';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const me = await requireUser();
  const approvals = listApprovals(me).sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt.localeCompare(a.createdAt));
  return json({ approvals });
});
