/**
 * Install a plugin. A Landflow node plugin runs third-party code on this machine: it is downloaded and hashed first, and without
 * `confirm: true` the answer is 409 with what would run and the `hash` of those files and of the way they are run (id, runtime, install and start commands, environment), and `changedSince` when an earlier
 * version was approved, for the UI to show before asking again. Send the `hash` back with `confirm: true`: if the files are not those any more
 * the answer is 409 `The plugin changed while you were confirming` with the new `hash`. A reinstall of files that were approved
 * before needs no confirm.
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
    const body = await parseBody(request, z.object({ confirm: z.boolean().optional(), hash: z.string().max(100).optional() }));
    if (!body.ok) return body.response;
    const result = await marketplace.install(id, decodeURIComponent(name), { confirm: body.data.confirm, hash: body.data.hash });
    if ('needsConfirmation' in result) return json(result, 409);
    recordAudit({ action: 'marketplace.install', target: { type: 'marketplace_plugin', id: decodeURIComponent(name), name: decodeURIComponent(name) }, summary: `Installed ${decodeURIComponent(name)} from a marketplace`, details: { marketplaceId: id, confirmed: Boolean(body.data.confirm), ...(body.data.hash && { hash: body.data.hash }), ...(result.installed.nodePlugin?.contentHash && { filesHash: result.installed.nodePlugin.contentHash }) } });
    return json(result, 201);
  }),
);
