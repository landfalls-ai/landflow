import { z } from 'zod';
import { error, handler, json, parseBody } from '@/lib/server/http';
import { variables } from '@/lib/server/variables';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ key: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  const variable = variables.get((await params).key);
  return variable ? json(variable) : error('Variable not found', 404);
});

/** PATCH { value?, key? } — a new `key` renames the variable. */
export const PATCH = handler(async (request: Request, { params }: Ctx) => {
  const body = await parseBody(request, z.object({ key: z.string().optional(), value: z.string().optional() }));
  if (!body.ok) return body.response;
  return json(variables.update((await params).key, body.data));
});

export const DELETE = handler(async (_request: Request, { params }: Ctx) =>
  variables.delete((await params).key) ? json({ ok: true }) : error('Variable not found', 404),
);
