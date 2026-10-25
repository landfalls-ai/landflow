/**
 * Install a plugin. A Landflow node plugin runs third-party code on this machine: without
 * `confirm: true` the answer is 409 with what would run, for the UI to show before asking again.
 */
import { z } from 'zod';
import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json, parseBody } from '@/lib/server/http';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; name: string }> };

export const POST = handler(
  marketplaceRoute(async (request: Request, { params }: Ctx) => {
    const { id, name } = await params;
    const body = await parseBody(request, z.object({ confirm: z.boolean().optional() }));
    if (!body.ok) return body.response;
    const result = await marketplace.install(id, decodeURIComponent(name), { confirm: body.data.confirm });
    return 'needsConfirmation' in result ? json(result, 409) : json(result, 201);
  }),
);
