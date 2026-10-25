/**
 * Install a plugin. A Landflow node plugin runs third-party code on this machine: without
 * `confirm: true` the answer is 409 with what would run, for the UI to show before asking again.
 */
import { z } from 'zod';
import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json, parseBody } from '@/lib/server/http';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ id: string; name: string }> };

export const POST = handler(
  marketplaceRoute(async (request: Request, { params }: Ctx) => {
    const { id, name } = await params;
    const body = await parseBody(request, z.object({ confirm: z.boolean().optional() }));
    if (!body.ok) return body.response;
    const result = await marketplace.install(id, decodeURIComponent(name), { confirm: body.data.confirm });
    if ('needsConfirmation' in result) return json(result, 409);
    recordAudit({ action: 'marketplace.install', target: { type: 'marketplace_plugin', id: decodeURIComponent(name), name: decodeURIComponent(name) }, summary: `Installed ${decodeURIComponent(name)} from a marketplace`, details: { marketplaceId: id, confirmed: Boolean(body.data.confirm) } });
    return json(result, 201);
  }),
);
