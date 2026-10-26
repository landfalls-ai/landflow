/** POST /api/mcp/gateway/sync: reconcile the gateway's targets with the registry now (owners and admins, `mcp:manage`); answers the status afterwards. */
import { error, handler, json } from '@/lib/server/http';
import { mcpGatewaySync } from '@/lib/server/mcp/gateway-sync';
import { recordAudit } from '@/lib/server/audit';

export const dynamic = 'force-dynamic';

export const POST = handler(async () => {
  if (mcpGatewaySync.mode === 'off') return error('The MCP gateway is off (LANDFLOW_MCP_GATEWAY=off)', 409);
  let result: Awaited<ReturnType<typeof mcpGatewaySync.reconcile>> | undefined;
  let failure: string | undefined;
  try {
    result = await mcpGatewaySync.reconcile();
  } catch (caught) {
    failure = (caught as Error).message;
  }
  recordAudit({
    action: 'settings.update',
    outcome: failure ? 'failure' : 'success',
    target: { type: 'settings', id: 'mcp-gateway', name: 'MCP gateway' },
    summary: failure ? `MCP gateway resync failed: ${failure}` : `Resynced the MCP gateway (${result!.upserted.length} written, ${result!.removed.length} removed)`,
    details: failure ? { error: failure } : { upserted: result!.upserted, removed: result!.removed, skipped: result!.skipped },
  });
  const status = await mcpGatewaySync.status();
  return json({ ...status, result: result ?? { changed: false, upserted: [], removed: [], skipped: failure } }, failure ? 502 : 200);
});
