import { z } from 'zod';
import { dataTables } from '@/lib/server/datatables';
import { dataTableRoute } from '@/lib/server/datatables/http';
import { json, parseBody } from '@/lib/server/http';
import { withOwnership } from '@/lib/server/projects';
import { createInProject, projectParam, routeActor } from '@/lib/server/projects/http';

export const dynamic = 'force-dynamic';

/** Every data table the caller sees (?projectId= keeps one project's), with its columns, row count and `ownership`, by name. */
export const GET = dataTableRoute(async (request: Request) => json({ tables: withOwnership(routeActor(), 'dataTable', dataTables().listTables(), projectParam(request)) }));

/** POST { name, columns?: [{ name, type: string | number | boolean | date }] } */
export const POST = dataTableRoute(async (request: Request) => {
  const body = await parseBody(request, z.object({ name: z.string(), columns: z.array(z.object({ name: z.string(), type: z.string() })).max(100).optional() }));
  if (!body.ok) return body.response;
  return json({ table: createInProject(request, 'dataTable', () => dataTables().createTable(body.data), (t) => t.id) }, 201);
});
