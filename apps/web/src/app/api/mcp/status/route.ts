/** GET /api/mcp/status: Settings → MCP's view of the gateway and identity configuration (env-driven; any signed-in user). */
import { can } from '@/lib/shared/auth';
import type { McpStatusView } from '@/lib/shared/mcp';
import { requireUser } from '@/lib/server/auth';
import { handler, json } from '@/lib/server/http';
import { gatewayAcceptsIdentityProvider, gatewayRoutePolicies, mcpGatewaySync } from '@/lib/server/mcp/gateway-sync';
import { gatewayMode, gatewaySecret, identityProviderIssuer, protectedResourceMetadataUrl } from '@/lib/server/mcp/identity';
import { mcpNamespace } from '@/lib/server/mcp/registry';
import { gatewayPublicUrl, instanceUrl } from '@/lib/server/mcp/tokens';

export const dynamic = 'force-dynamic';

export const GET = handler(async () => {
  const me = await requireUser();
  const idp = identityProviderIssuer();
  const auth = gatewayRoutePolicies()?.mcpAuthentication as { issuer?: unknown; mode?: unknown } | undefined;
  const jwtProviders = (gatewayRoutePolicies()?.jwtAuth as { providers?: Array<{ issuer?: unknown }>; mode?: unknown } | undefined)?.providers;
  // An operator's own `jwtAuth` lists the issuers; with `mcpAuthentication` for Landflow's tokens the sync adds the identity provider (ACCEPT_IDP).
  const accepted = typeof auth?.issuer === 'string' && auth.issuer.replace(/\/+$/, '') === instanceUrl() && idp && idp !== instanceUrl() && gatewayAcceptsIdentityProvider() ? idp : undefined;
  const signIn =
    typeof auth?.issuer === 'string'
      ? { issuer: auth.issuer, mode: typeof auth.mode === 'string' ? auth.mode : 'strict', ...(accepted && { alsoIssuer: accepted }) }
      : Array.isArray(jwtProviders) && typeof jwtProviders[0]?.issuer === 'string'
        ? { issuer: jwtProviders[0].issuer, mode: String((gatewayRoutePolicies()?.jwtAuth as { mode?: unknown }).mode ?? 'strict'), ...(typeof jwtProviders[1]?.issuer === 'string' && { alsoIssuer: jwtProviders[1].issuer }) }
        : undefined;
  const status: McpStatusView = {
    gateway: {
      mode: gatewayMode(),
      ...(gatewayPublicUrl() && { publicUrl: gatewayPublicUrl() }),
      secretConfigured: Boolean(gatewaySecret()),
      sync: gatewayMode() === 'off' ? 'off' : mcpGatewaySync.isRunning ? 'running' : 'stopped',
      ...(signIn && { signIn }),
    },
    instanceUrl: instanceUrl(),
    ...(idp && { identityProvider: { issuer: idp } }),
    namespace: mcpNamespace(),
    paths: { jwks: '/api/mcp/jwks', registry: '/api/mcp/registry/v0.1/servers', plugins: '/api/mcp/plugins', protectedResourceMetadata: new URL(protectedResourceMetadataUrl({})).pathname },
    canManage: can(me, 'mcp:manage'),
  };
  return json(status);
});
