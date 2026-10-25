import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { VariableError, variables } from '@/lib/server/variables';

export const dynamic = 'force-dynamic';

/** `[{ key, value }]`, sorted by key (also what the expression editor suggests after `$vars.`). */
export const GET = handler(async () => json(variables.list()));

/** POST { key, value } */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, z.object({ key: z.string(), value: z.string() }));
  if (!body.ok) return body.response;
  try {
    return json(variables.create(body.data), 201);
  } catch (caught) {
    if (caught instanceof VariableError) return error(caught.message, caught.status);
    throw caught;
  }
});
