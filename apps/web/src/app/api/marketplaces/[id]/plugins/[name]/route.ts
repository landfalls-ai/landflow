import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; name: string }> };

/** What the plugin contains (reads its files): agents, skills, node plugin, unsupported components, README. */
export const GET = handler(
  marketplaceRoute(async (request: Request, { params }: Ctx) => {
    const { id, name } = await params;
    const fresh = new URL(request.url).searchParams.get('fresh') === '1';
    return json({ plugin: await marketplace.detail(id, decodeURIComponent(name), fresh) });
  }),
);
