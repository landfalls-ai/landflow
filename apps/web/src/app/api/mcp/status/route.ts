/** GET /api/mcp/status: Settings → MCP's view of the gateway and identity configuration (env-driven; any signed-in user). */
import { can } from '@/lib/shared/auth';
import type { McpStatusView } from '@/lib/shared/mcp';
import { requireUser } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { mcpGatewaySync } from '@/lib/server/mcp/gateway-sync';
import { gatewayMode, gatewaySecret, identityProviderIssuer, protectedResourceMetadataUrl } from '@/lib/server/mcp/identity';
import { mcpNamespace } from '@/lib/server/mcp/registry';
import { gatewayPublicUrl, instanceUrl } from '@/lib/server/mcp/tokens';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const me = await requireUser();
  const idp = identityProviderIssuer();
  const status: McpStatusView = {
    gateway: { mode: gatewayMode(), ...(gatewayPublicUrl() && { publicUrl: gatewayPublicUrl() }), secretConfigured: Boolean(gatewaySecret()), sync: gatewayMode() === 'off' ? 'off' : mcpGatewaySync.isRunning ? 'running' : 'stopped' },
    instanceUrl: instanceUrl(),
    ...(idp && { identityProvider: { issuer: idp } }),
    namespace: mcpNamespace(),
    paths: { jwks: '/api/mcp/jwks', registry: '/api/mcp/registry/v0.1/servers', plugins: '/api/mcp/plugins', protectedResourceMetadata: new URL(protectedResourceMetadataUrl({})).pathname },
    canManage: can(me, 'mcp:manage'),
  };
  return json(status);
});
