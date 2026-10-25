/** GET/POST /api/folders — folders of the workflows list. */
import { z } from 'zod';
import { FolderError, folders } from '@/lib/server/folders';
import { error, handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

const createSchema = z.object({ name: z.string(), parentId: z.string().optional() });

export const GET = handler(async () => json({ folders: folders.list() }));

export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, createSchema);
  if (!body.ok) return body.response;
  try {
    return json({ folder: folders.create(body.data) }, 201);
  } catch (caught) {
    if (caught instanceof FolderError) return error(caught.message, caught.status);
    throw caught;
  }
});
