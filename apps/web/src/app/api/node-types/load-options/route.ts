import { z } from 'zod';
import type { JsonObject } from '@landflow/protocol';
import { credentials } from '@/lib/server/credentials/vault';
import { registry } from '@/lib/server/plugins/registry';
import { handler, json, parseBody } from '@/lib/server/http';

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
    }),
  );
  if (!body.ok) return body.response;
  try {
    const { type, method, parameters } = body.data;
    const resolved = registry.resolve(type);
    const data = body.data.credentials && !('error' in resolved) ? credentials.resolveFor({ type, credentials: body.data.credentials, parameters }, resolved.descriptor, true) : undefined;
    return json({ options: await registry.loadOptions(type, method, parameters as JsonObject, data && Object.keys(data).length ? data : undefined) });
  } catch (caught) {
    return json({ options: [], error: (caught as Error).message });
  }
});
