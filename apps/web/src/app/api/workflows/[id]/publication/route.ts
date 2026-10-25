/**
 * GET /api/workflows/:id/publication — what is published (version, when, by whom, note), the draft, whether the
 * draft has unpublished changes, the publish timeline and where each app webhook trigger stands.
 */
import { error, handler, json } from '@/lib/server/http';
import { publicationStatus, PublishError } from '@/lib/server/publish';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  try {
    return json(await publicationStatus((await params).id));
  } catch (caught) {
    if (caught instanceof PublishError) return error(caught.message, caught.status);
    throw caught;
  }
});
