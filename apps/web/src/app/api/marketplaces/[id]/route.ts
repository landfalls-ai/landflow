import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

/** The catalog; the first open of a marketplace fetches it. */
export const GET = handler(marketplaceRoute(async (_request: Request, { params }: Ctx) => json(await marketplace.catalog((await params).id))));

export const DELETE = handler(
  marketplaceRoute(async (_request: Request, { params }: Ctx) => {
    marketplace.remove((await params).id);
    return json({ ok: true });
  }),
);
