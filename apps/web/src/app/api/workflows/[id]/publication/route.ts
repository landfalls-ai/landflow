/**
 * GET /api/workflows/:id/publication — what is published (version, when, by whom, note), the draft, whether the
 * draft has unpublished changes, the publish timeline and where each app webhook trigger stands.
 */
import { handler, json } from '@/lib/server/http';
import { publicationStatus } from '@/lib/server/publish';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const GET = handler(async (_request: Request, { params }: Ctx) => {
  return json(await publicationStatus((await params).id));
});
