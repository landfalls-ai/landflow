/** Import an agent exported from the builder ("…" → Export): a new agent with that config as its draft. */
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { agentConfigSchema, asConfig } from '@/lib/server/agents/http';
import { agentStore } from '@/lib/server/agents/store';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const POST = handler(async (request: Request) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return error('Request body must be JSON');
  }
  const raw = z.object({ config: z.unknown() }).safeParse(body).success ? (body as { config: unknown }).config : body;
  const parsed = agentConfigSchema.safeParse(raw);
  if (!parsed.success) return error('That isn’t an exported agent', 400, { issues: parsed.error.issues.slice(0, 10) });
  const config = asConfig(parsed.data);
  // Fresh ids, so importing the same file twice doesn't share schedule or channel state.
  const reid = <T extends { id: string }>(items: T[] | undefined, prefix: string) => items?.map((item) => ({ ...item, id: `${prefix}_${nanoid(8)}` }));
  return json(
    {
      agent: agentStore.create({
        ...config,
        skills: reid(config.skills, 'sk'),
        tools: reid(config.tools, 'tl'),
        schedules: reid(config.schedules, 'sc')?.map((s) => ({ ...s, enabled: false })),
        channels: reid(config.channels, 'ch')?.map((c) => ({ ...c, enabled: false })),
      }),
    },
    201,
  );
});
