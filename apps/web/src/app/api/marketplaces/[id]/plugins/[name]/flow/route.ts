import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { error, handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; name: string }> };

/** One flow for its share page (read only): `?path=` is the file in the plugin; `:id` may be the marketplace's name. */
export const GET = handler(
  marketplaceRoute(async (request: Request, { params }: Ctx) => {
    const { id, name } = await params;
    const path = new URL(request.url).searchParams.get('path');
    if (!path) return error('Add ?path= with the flow’s file in the plugin', 400);
    return json({ flow: await marketplace.flow(decodeURIComponent(id), decodeURIComponent(name), path) });
  }),
);
