import { handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { PracticeError } from '@/lib/server/practices/errors';
import { retirePractice } from '@/lib/server/practices/approve';
import { versionsOf } from '@/lib/server/practices/store';
import { viewOf, visiblePractice } from '@/lib/server/practices/views';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** POST — retire the practice: agents stop getting it. */
export const POST = handler(async (_request: Request, { params }: Ctx) => {
  const actor = routeActor();
  const { id } = await params;
  if (!visiblePractice(actor, id)) throw new PracticeError('Practice not found', 404);
  const practice = retirePractice(actor, id);
  return json({ practice: viewOf(actor, practice, versionsOf(id)) });
});
