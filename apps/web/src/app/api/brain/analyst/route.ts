/**
 * POST /api/brain/analyst — make and publish the Platform analyst (docs/second-brain.md#the-analyst-agent) in
 * `?projectId=`, else the caller's project. Returns `{ agent }`; it is an ordinary agent from then on.
 */
import { currentPrincipal } from '@/lib/server/auth/guard';
import { publishAndTrust } from '@/lib/server/trust/publish'; // C27:
import { analystConfig } from '@/lib/server/brain/analyst';
import { agentStore } from '@/lib/server/agents/store';
import { handler, json } from '@/lib/server/http';
import { createInProject } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const agent = createInProject(
    request,
    'agent',
    () => {
      const created = agentStore.create(analystConfig());
      return publishAndTrust(created.id, currentPrincipal()?.user)?.agent ?? created;
    },
    (a) => a.id,
  );
  return json({ agent }, 201);
});
