import { z } from 'zod';
import { error, handler, json } from '@/lib/server/http';
import { routeActor } from '@/lib/server/projects/http';
import { MAX_ITEM_IDS, memoryItemStates } from '@/lib/server/memory/items';

export const dynamic = 'force-dynamic';

/**
 * GET ?ids=a,b,c (at most 50): `{ items: [{ id, live, version?, text?, forgottenAt?, reason? }] }`, the memories a run was
 * given as they are now (What it saw → Memory marks the forgotten ones). Facts follow their subject's access, notes their
 * team's; an id the caller may not see is left out. Reads only.
 */
export const GET = handler(async (request: Request) => {
  const actor = routeActor();
  const raw = new URL(request.url).searchParams.get('ids') ?? '';
  const parsed = z.array(z.string().min(1).max(300)).max(MAX_ITEM_IDS, `Ask for at most ${MAX_ITEM_IDS} ids`).safeParse(raw ? raw.split(',') : []);
  if (!parsed.success) return error(parsed.error.issues[0]?.message ?? 'Bad ids', 400);
  return json({ items: memoryItemStates(actor, parsed.data) });
});
