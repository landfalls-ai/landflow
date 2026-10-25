import { z } from 'zod';
import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => json({ marketplaces: marketplace.list(), presets: marketplace.presets(), installed: marketplace.installed() }));

/** Add a marketplace: `owner/repo[@ref]`, a github.com URL or a marketplace.json URL. It is fetched before it's saved. */
export const POST = handler(
  marketplaceRoute(async (request: Request) => {
    const body = await parseBody(request, z.object({ input: z.string().trim().min(1).max(500) }));
    if (!body.ok) return body.response;
    return json({ marketplace: await marketplace.add(body.data.input) }, 201);
  }),
);
