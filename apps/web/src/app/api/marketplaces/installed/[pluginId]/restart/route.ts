import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ pluginId: string }> };

export const POST = handler(marketplaceRoute(async (_request: Request, { params }: Ctx) => json({ installed: await marketplace.restart(decodeURIComponent((await params).pluginId)) })));
