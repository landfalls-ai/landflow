/**
 * GET /api/usage/kinds/:kind — one declared kind. DELETE forgets its declaration; the events already recorded stay in the
 * ledger (and in reports), but Record Event stops accepting the kind until it is declared again.
 */
import { error, handler, json } from '@/lib/server/http';
import { deleteKind, getKind } from '@/lib/server/usage/kinds';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ kind: string }> };

export const GET = handler(async (_request: Request, { params }: Context) => {
  const def = getKind(decodeURIComponent((await params).kind));
  return def ? json({ kind: def }) : error('No such kind', 404);
});

export const DELETE = handler(async (_request: Request, { params }: Context) => {
  return deleteKind(decodeURIComponent((await params).kind)) ? json({ ok: true }) : error('No such kind', 404);
});
