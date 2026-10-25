import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ pluginId: string }> };

/** A node plugin's recent output (install and process logs). */
export const GET = handler(marketplaceRoute(async (_request: Request, { params }: Ctx) => json({ lines: marketplace.logs(decodeURIComponent((await params).pluginId)) })));
