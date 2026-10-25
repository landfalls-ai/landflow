import { marketplaceRoute } from '@/lib/server/marketplace/http';
import { marketplace } from '@/lib/server/marketplace/service';
import { handler, json } from '@/lib/server/http';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';
type Ctx = { params: Promise<{ pluginId: string }> };

/** Uninstall: removes the agents, library skills and node plugin this install created. */
export const DELETE = handler(
  marketplaceRoute(async (_request: Request, { params }: Ctx) => {
    const pluginId = decodeURIComponent((await params).pluginId);
    const result = await marketplace.uninstall(pluginId);
    recordAudit({ action: 'marketplace.uninstall', target: { type: 'marketplace_plugin', id: pluginId, name: pluginId } });
    return json(result);
  }),
);
