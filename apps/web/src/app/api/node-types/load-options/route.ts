import { z } from 'zod';
import type { JsonObject } from '@landflow/protocol';
import { credentials } from '@/lib/server/credentials/vault';
import { withTableScope } from '@/lib/server/datatables/projects';
import { registry } from '@/lib/server/plugins/registry';
import { handler, json, parseBody } from '@/lib/server/http';
import { canResource, homeProjectId, projectRole, requireResource } from '@/lib/server/projects';
import { routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  const body = await parseBody(
    request,
    z.object({
      type: z.string(),
      method: z.string(),
      parameters: z.record(z.string(), z.unknown()).default({}),
      /** The node's credential references; their decrypted values go to the plugin. */
      credentials: z.record(z.string(), z.object({ id: z.string(), name: z.string() })).optional(),
      /** The workflow being edited (or the project it goes to): pickers of project-scoped things (data tables) list that project's. */
      workflowId: z.string().max(200).optional(),
      projectId: z.string().max(200).optional(),
      /** The agent being edited: its tools' pickers list its project's data tables. */
      agentId: z.string().max(200).optional(),
    }),
  );
  if (!body.ok) return body.response;
  const actor = routeActor();
  // The plugin gets the credentials' values: only for credentials the caller may use.
  for (const ref of Object.values(body.data.credentials ?? {})) requireResource(actor, 'credential', ref.id, 'use');
  const { workflowId, agentId, projectId: requested } = body.data;
  const projectId =
    workflowId && canResource(actor, 'workflow', workflowId, 'read')
      ? homeProjectId('workflow', workflowId)
      : agentId && canResource(actor, 'agent', agentId, 'read')
        ? homeProjectId('agent', agentId)
        : requested && projectRole(actor, requested)
          ? requested
          : undefined;
  try {
    const { type, method, parameters } = body.data;
    const resolved = registry.resolve(type);
    const data = body.data.credentials && !('error' in resolved) ? credentials.resolveFor({ type, credentials: body.data.credentials, parameters }, resolved.descriptor, true) : undefined;
    const options = await withTableScope({ projectId, actor }, () => registry.loadOptions(type, method, parameters as JsonObject, data && Object.keys(data).length ? data : undefined));
    return json({ options });
  } catch (caught) {
    return json({ options: [], error: (caught as Error).message });
  }
});
