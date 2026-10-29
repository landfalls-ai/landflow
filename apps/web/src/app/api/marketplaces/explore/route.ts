import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

/** Every added marketplace at once for Explore: plugins, the Landflow plugins' flows, and what couldn't be read. */
export const GET = handler(marketplaceRoute(async () => json(await marketplace.explore())));
