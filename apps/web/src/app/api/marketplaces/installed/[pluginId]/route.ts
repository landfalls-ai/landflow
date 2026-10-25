import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ pluginId: string }> };

/** Uninstall: removes the agents, library skills and node plugin this install created. */
export const DELETE = handler(marketplaceRoute(async (_request: Request, { params }: Ctx) => json(await marketplace.uninstall(decodeURIComponent((await params).pluginId)))));
