import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ installed: marketplace.installed() }));
