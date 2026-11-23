'use client';
/** Settings → MCP → Gateway: the bundled MCP gateway's mode, URL, sign-in and sync status (docs/transports.md "The bundled MCP gateway"). */
import { useCallback, useEffect, useState } from 'react';
import { Network, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { McpGatewayStatusView, McpGatewayTargetView, McpStatusView } from '@/lib/shared/mcp';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SectionLabel } from '@/components/ui/inputs';
import { Alert } from './mcp-common';

// ---- gateway and client config ---------------------------------------------------------

export function GatewayCard({ status }: { status: McpStatusView }) {
  const mode = status.gateway.mode;
  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <Network className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>MCP gateway</SectionLabel>
        <Badge tone={mode === 'off' ? 'muted' : 'accent'} className="ml-auto font-mono">
          {mode}
        </Badge>
      </div>
      <p className="text-[13px] leading-relaxed text-t2">
        Every installed plugin is also an MCP server. Agents connect to the bundled gateway (agentgateway) with one URL for every plugin, sign in through the identity provider or
        with a Landflow MCP token, and the gateway hands this host the caller’s identity. Each plugin also has a direct endpoint here, <span className="font-mono text-[12px] text-t1">{status.paths.plugins}/&lt;plugin&gt;</span>.
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-1.5 text-[12px] sm:grid-cols-[auto_1fr]">
        <dt className="text-t3">Mode</dt>
        <dd className="text-t1">
          <code className="font-mono">LANDFLOW_MCP_GATEWAY={mode}</code>
          {mode === 'off' && <span className="text-t3"> — agents can still call the direct endpoints with a token</span>}
        </dd>
        <dt className="text-t3">Gateway URL</dt>
        <dd className="font-mono text-t1">{status.gateway.publicUrl ? `${status.gateway.publicUrl}/mcp` : <span className="text-t3">not set (LANDFLOW_MCP_GATEWAY_PUBLIC_URL)</span>}</dd>
        <dt className="text-t3">Gateway secret</dt>
        <dd>
          {status.gateway.secretConfigured ? (
            <Badge tone="success">configured</Badge>
          ) : (
            <span className="text-warn">
              <Badge tone="warning">missing</Badge> set <code className="font-mono">LANDFLOW_MCP_GATEWAY_SECRET</code>: without it the host refuses calls from the gateway
            </span>
          )}
        </dd>
        <dt className="text-t3">Sign-in</dt>
        <dd className="text-t1">
          {status.identityProvider ? (
            <>
              the identity provider <span className="font-mono">{status.identityProvider.issuer}</span>, or Landflow MCP tokens
            </>
          ) : (
            <>
              Landflow MCP tokens (no identity provider: set <code className="font-mono">LANDFLOW_OIDC_ISSUER</code> for SSO)
            </>
          )}
        </dd>
        {mode !== 'off' && (
          <>
            <dt className="text-t3">At the gateway</dt>
            <dd className="text-t1">{status.gateway.signIn ? <GatewaySignIn signIn={status.gateway.signIn} status={status} /> : <GatewayNoSignIn />}</dd>
          </>
        )}
        <dt className="text-t3">Token keys</dt>
        <dd className="font-mono text-t1">
          {status.instanceUrl}
          {status.paths.jwks}
        </dd>
        <dt className="text-t3">Catalog</dt>
        <dd className="font-mono text-t1">
          {status.instanceUrl}
          {status.paths.registry} <span className="font-sans text-t3">(namespace {status.namespace})</span>
        </dd>
      </dl>
      {mode !== 'off' && <GatewaySyncStatus canManage={status.canManage} />}
    </Card>
  );
}

/** Whose tokens the gateway checks on the per-plugin routes (LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES). */
function GatewaySignIn({ signIn, status }: { signIn: NonNullable<McpStatusView['gateway']['signIn']>; status: McpStatusView }) {
  const whose = signIn.issuer === status.instanceUrl ? 'Landflow MCP tokens' : signIn.issuer === status.identityProvider?.issuer ? 'the identity provider’s tokens' : <span className="font-mono">{signIn.issuer}</span>;
  return (
    <>
      <Badge tone="success">on</Badge> {whose}
      {signIn.alsoIssuer && (
        <>
          {' '}and {signIn.alsoIssuer === status.identityProvider?.issuer ? 'the identity provider’s tokens' : <span className="font-mono">{signIn.alsoIssuer}</span>}
        </>
      )}
      {signIn.mode === 'optional' && <span className="text-t3"> — a call without a token is anonymous (no tools), a bad token gets 401</span>}
    </>
  );
}

function GatewayNoSignIn() {
  return (
    <span className="text-warn">
      <Badge tone="warning">off</Badge> the per-plugin routes check no tokens (<code className="font-mono">LANDFLOW_MCP_GATEWAY_ROUTE_POLICIES</code>), and{' '}
      <code className="font-mono">/mcp</code> signs in only if the gateway’s config has <code className="font-mono">mcpAuthentication</code>. Without it agents there are
      anonymous and see no tools; the direct endpoints still take tokens.
    </span>
  );
}

const TARGET_STATE_TONE: Record<McpGatewayTargetView['state'], 'success' | 'warning' | 'danger' | 'muted'> = { 'in-step': 'success', drift: 'warning', missing: 'danger', stale: 'warning', unknown: 'muted' };

/** The sync's view (GET /api/mcp/gateway): health, targets in step vs drift, last sync and error, a resync button for admins. */
function GatewaySyncStatus({ canManage }: { canManage: boolean }) {
  const [gateway, setGateway] = useState<McpGatewayStatusView>();
  const [error, setError] = useState<string>();
  const [syncing, setSyncing] = useState(false);
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(async () => {
    try {
      setGateway(await api<McpGatewayStatusView>('/api/mcp/gateway', { background: true }));
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const resync = async () => {
    setSyncing(true);
    try {
      const r = await api<McpGatewayStatusView & { result: { upserted: string[]; removed: string[]; skipped?: string } }>('/api/mcp/gateway/sync', { method: 'POST' });
      setGateway(r);
      toast.success(r.result.skipped ? r.result.skipped : `Gateway synced: ${r.result.upserted.length} written, ${r.result.removed.length} removed`);
    } catch (e) {
      toast.error((e as Error).message);
      await load();
    } finally {
      setSyncing(false);
    }
  };

  if (error) return <Alert>{error}</Alert>;
  if (!gateway) return <div className="mt-3 h-10 rounded-xl border border-hair bg-sf animate-pulse-soft" />;
  const targets = gateway.targets.filter((t) => t.kind === 'mcp.target');
  const routes = gateway.targets.filter((t) => t.kind === 'traffic.route');
  const shown = showAll ? gateway.targets : targets;
  return (
    <div className="mt-4 border-t border-hair pt-3">
      <div className="flex flex-wrap items-center gap-2 text-[12px]">
        <span className="font-semibold text-t2">Target sync</span>
        {gateway.health ? (
          <Badge tone={gateway.health.ok ? 'success' : 'danger'}>{gateway.health.ok ? `gateway reachable${gateway.health.version ? ` · ${gateway.health.version}` : ''}` : 'gateway unreachable'}</Badge>
        ) : null}
        <Badge tone={gateway.running ? 'accent' : 'muted'}>{gateway.running ? 'running' : 'not running'}</Badge>
        <Badge tone="success">{gateway.inStep} in step</Badge>
        {gateway.drift > 0 && <Badge tone="warning">{gateway.drift} drift</Badge>}
        <span className="text-t3">
          {gateway.adapter} · {gateway.location}
          {gateway.lastSyncAt ? ` · synced ${timeAgo(gateway.lastSyncAt)}` : ' · not synced yet'}
          {gateway.lastChangeAt ? ` · last change ${timeAgo(gateway.lastChangeAt)}` : ''}
        </span>
        {canManage && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void resync()} disabled={syncing} aria-label="Resync the gateway">
            <RefreshCw className={`size-3.5 ${syncing ? 'animate-spin' : ''}`} /> Resync
          </Button>
        )}
      </div>
      {!gateway.running && (
        <p className="mt-1.5 text-[12px] text-t3">The sync starts with the host (a dev server started before this build needs a restart); until then the targets are what the gateway last had.</p>
      )}
      {gateway.health && !gateway.health.ok && gateway.health.message && <p className="mt-1.5 text-[12px] text-danger">{gateway.health.message}</p>}
      {gateway.lastError && <p className="mt-1.5 text-[12px] text-danger">Last error: {gateway.lastError}</p>}
      {shown.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="mcp-gateway-targets">
          {shown.map((t) => (
            <Badge key={`${t.kind}:${t.name}`} tone={TARGET_STATE_TONE[t.state]} className="font-mono font-medium" title={`${t.kind} ${t.name} (${t.label}): ${t.state}`} data-server-kind={t.serverKind}>
              {t.serverKind === 'plugin' ? t.name : `${t.serverKind}: ${t.name}`} · {t.state}
            </Badge>
          ))}
        </div>
      )}
      {routes.length > 0 && (
        <button type="button" className="mt-1.5 text-[11px] text-t3 underline-offset-2 hover:underline" onClick={() => setShowAll((v) => !v)}>
          {showAll ? 'Hide' : 'Show'} the {routes.length} per-plugin routes (<span className="font-mono">/mcp/plugins/&lt;plugin&gt;</span> and <span className="font-mono">…/server-card</span>)
        </button>
      )}
      <p className="mt-1.5 text-[11px] text-t3">
        Targets reach this host at <span className="font-mono">{gateway.hostUrl}</span> (<span className="font-mono">LANDFLOW_MCP_GATEWAY_HOST_URL</span>). It also registers the instance server (when on) and each published workflow's MCP Server Trigger. The sync reacts to plugins coming and going, reconciles every 30 s, removes a plugin offline
        for 60 s, and only ever touches the targets it created.
      </p>
    </div>
  );
}
