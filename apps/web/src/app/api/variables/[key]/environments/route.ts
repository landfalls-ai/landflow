/**
 * A variable's per-environment values: GET `{ key, values: { env: value } }`; PUT `{ values: { env: value | null } }`
 * sets (or, with null, removes) values and leaves the other environments alone. On an instance whose
 * LANDFLOW_ENVIRONMENT has a value, `$vars.KEY` reads it instead of the variable's own value.
 */
import { z } from 'zod';
import { EnvironmentError, environmentValues } from '@/lib/server/environments';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { variables } from '@/lib/server/variables';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ key: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const key = (await params).key;
  return variables.get(key) ? json({ key, values: environmentValues.of(key) }) : error('Variable not found', 404);
});

export const PUT = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.strictObject({ values: z.record(z.string(), z.string().nullable()) }));
  if (!body.ok) return body.response;
  const key = (await params).key;
  if (!variables.get(key)) return error('Variable not found', 404);
  try {
    return json({ key, values: environmentValues.set(key, body.data.values) });
  } catch (caught) {
    if (caught instanceof EnvironmentError) return error(caught.message, caught.status);
    throw caught;
  }
});
