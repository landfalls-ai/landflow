import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string }> };

export const POST = handler(marketplaceRoute(async (_request: Request, { params }: Ctx) => json({ marketplace: await marketplace.refresh((await params).id) })));
