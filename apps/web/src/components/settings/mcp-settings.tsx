'use client';
/**
 * Settings → MCP (docs/transports.md "The bundled MCP gateway"): the gateway (mode, URL, secret, sync status), how to
 * connect a client (Claude Code / generic MCP JSON for the gateway and the direct per-plugin endpoints), your
 * Landflow-issued MCP tokens (issue with scopes and expiry, copy once, revoke, last used), the tool grants (owners and
 * admins), approvals of destructive tool calls (the ones a person may answer), the tool browser (GET /api/mcp/tools, stream T2-E; an empty state until it exists), and the instance MCP
 * server for coding agents (/api/mcp, its own on/off switch and token).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Network, Plug, Plus, RefreshCw, ShieldAlert, ShieldCheck, Trash2, TriangleAlert, Wrench, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { UserView } from '@/lib/shared/auth';
import { MCP_GRANT_SUBJECT_KINDS, MCP_TOKEN_SCOPE_LABELS, MCP_TOKEN_SCOPES, type McpAccessResponse, type McpAccessView, type McpGatewayStatusView, type McpGatewayTargetView, type McpGrantSubjectKind, type McpStatusView, type McpTokenScope, type McpTokenView, type McpToolGrant, type McpToolsResponse } from '@/lib/shared/mcp';
import { MCP_APPROVAL_LABELS, MCP_APPROVAL_MODES, type McpApprovalMode, type McpApprovalView } from '@/lib/shared/mcp-approval';
import type { CredentialSummary, PluginSummary } from '@/lib/shared/types';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, SectionLabel, Select, Switch } from '@/components/ui/inputs';

const PLACEHOLDER = '<token>';

function Snippet({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[12px] font-semibold text-t2">{label}</span>
        <CopyButton text={text} label={`Copy ${label.toLowerCase()}`} className="ml-auto" />
      </div>
      <pre className="overflow-x-auto rounded-[10px] border border-hair bg-wl px-3 py-2.5 font-mono text-[12px] leading-relaxed text-t1">{text}</pre>
    </div>
  );
}

const Alert = ({ children, tone = 'danger' }: { children: React.ReactNode; tone?: 'danger' | 'warning' }) => (
  <div className={tone === 'danger' ? 'rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up' : 'flex gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn'}>{children}</div>
);

// ---- gateway and client config ---------------------------------------------------------

function GatewayCard({ status }: { status: McpStatusView }) {
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
      setGateway(await api<McpGatewayStatusView>('/api/mcp/gateway'));
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
              {t.serverKind === 'plugin' ? t.name : `${t.serverKind === 'instance' ? 'instance' : 'workflow'}: ${t.name}`} · {t.state}
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

function ConnectCard({ status, token, plugins }: { status: McpStatusView; token?: string; plugins: McpToolsResponse['plugins'] }) {
  const [plugin, setPlugin] = useState<string>('');
  const shown = token ?? PLACEHOLDER;
  const gateway = status.gateway.publicUrl && status.gateway.mode !== 'off' ? `${status.gateway.publicUrl}/mcp` : undefined;
  const direct = `${status.instanceUrl}${status.paths.plugins}/${plugin || '<plugin>'}`;
  const url = gateway ?? direct;
  const name = gateway ? 'landflow' : `landflow-${plugin || 'plugin'}`;
  const command = `claude mcp add --transport http ${name} ${url} --header "Authorization: Bearer ${shown}"`;
  const config = JSON.stringify({ mcpServers: { [name]: { type: 'http', url, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2);
  return (
    <Card className="space-y-4 px-5 py-4">
      <div className="flex items-center gap-2">
        <Plug className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Connect an agent</SectionLabel>
      </div>
      <p className="text-[13px] text-t2">
        {gateway ? (
          <>
            The gateway URL serves every plugin you may use (tools are prefixed with the plugin: <code className="font-mono text-[12px] text-t1">twilio_message_send</code>); one plugin is{' '}
            <code className="font-mono text-[12px] text-t1">{gateway}/plugins/&lt;plugin&gt;</code>.
          </>
        ) : (
          'Without a gateway URL, agents connect to one plugin’s endpoint on this host at a time.'
        )}
      </p>
      {!gateway && plugins.length > 0 && (
        <div className="max-w-xs">
          <FieldLabel>Plugin</FieldLabel>
          <Select value={plugin} onChange={(e) => setPlugin(e.target.value)}>
            <option value="">Pick a plugin…</option>
            {plugins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.tools} tools)
              </option>
            ))}
          </Select>
        </div>
      )}
      <Snippet label="Claude Code command" text={command} />
      <Snippet label="MCP client JSON" text={config} />
      {gateway && <Snippet label="Direct endpoint of one plugin (no gateway)" text={`${status.instanceUrl}${status.paths.plugins}/<plugin>`} />}
      {!token && <p className="text-[12px] text-t3">Replace {PLACEHOLDER} with a Landflow MCP token from below, or with an access token from the identity provider.</p>}
    </Card>
  );
}

// ---- tokens -----------------------------------------------------------------------------

function IssueToken({ onCancel, onIssued }: { onCancel: () => void; onIssued: (token: string, record: McpTokenView) => void }) {
  const [label, setLabel] = useState('');
  const [scopes, setScopes] = useState<McpTokenScope[]>([...MCP_TOKEN_SCOPES]);
  const [days, setDays] = useState('30');
  const [busy, setBusy] = useState(false);
  const toggle = (scope: McpTokenScope) => setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ token: string; record: McpTokenView }>('/api/mcp/tokens', { method: 'POST', json: { label, scopes, expiresInDays: Number(days) || 30 } });
      onIssued(r.token, r.record);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <SectionLabel>New MCP token</SectionLabel>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={onCancel} aria-label="Close">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Claude Code on my laptop" autoFocus />
        </div>
        <div>
          <FieldLabel>Expires in (days, 1–365)</FieldLabel>
          <Input type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} />
        </div>
        <div className="sm:col-span-2">
          <FieldLabel>Scopes</FieldLabel>
          <div className="flex flex-wrap gap-3">
            {MCP_TOKEN_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-[13px] text-t2">
                <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} className="accent-ac" />
                <code className="font-mono text-[12px] text-t1">{scope}</code>
                <span className="text-t3">{MCP_TOKEN_SCOPE_LABELS[scope]}</span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!label.trim() || scopes.length === 0}>
          Issue token
        </Button>
      </div>
    </Card>
  );
}

function TokensCard({ canManage, onToken }: { canManage: boolean; onToken: (token: string) => void }) {
  const [tokens, setTokens] = useState<McpTokenView[]>();
  const [all, setAll] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [created, setCreated] = useState<{ token: string; label: string }>();
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const r = await api<{ tokens: McpTokenView[] }>(`/api/mcp/tokens${all ? '?all=1' : ''}`);
      setTokens(r.tokens);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [all]);
  useEffect(() => void load(), [load]);

  const revoke = async (token: McpTokenView) => {
    setConfirm(undefined);
    try {
      await api(`/api/mcp/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
      toast.success(`Revoked “${token.label}”`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  /** A revoked or expired token's row can go (rows older than 30 days are purged on their own). */
  const remove = async (token: McpTokenView) => {
    setConfirm(undefined);
    try {
      await api(`/api/mcp/tokens/${encodeURIComponent(token.id)}`, { method: 'DELETE' });
      toast.success(`Removed “${token.label}”`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const state = (t: McpTokenView): { label: string; tone: 'danger' | 'muted' | 'success' } | undefined => {
    if (t.revokedAt) return { label: 'revoked', tone: 'danger' };
    if (Date.parse(t.expiresAt) <= Date.now()) return { label: 'expired', tone: 'muted' };
    return undefined;
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <KeyRound className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>MCP tokens</SectionLabel>
        {canManage && (
          <label className="ml-auto flex items-center gap-2 text-[12px] text-t3">
            <Switch checked={all} onChange={setAll} label="Everyone’s tokens" /> everyone’s
          </label>
        )}
      </div>
      <p className="text-[13px] text-t2">
        Signed tokens agents send as <code className="font-mono text-[12px] text-t1">Authorization: Bearer …</code> to the gateway or a plugin’s endpoint. They act as you within your grants and their scopes; revoking one takes
        effect on the next call.
      </p>
      {created && (
        <Card className="space-y-2 border-acbd px-5 py-4 animate-fade-up">
          <div className="flex items-start gap-2 text-[13px]">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.8} />
            <span className="min-w-0 flex-1 text-t2">
              <span className="font-semibold text-t1">Copy “{created.label}” now.</span> You won’t see this token again; Landflow keeps only a hash of it. The snippets above are filled in with it.
            </span>
            <button onClick={() => setCreated(undefined)} aria-label="Dismiss" className="text-t3 hover:text-t1">
              <X className="size-3.5" />
            </button>
          </div>
          <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
            <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" data-testid="new-mcp-token">
              {created.token}
            </code>
            <CopyButton text={created.token} label="Copy token" />
          </div>
        </Card>
      )}
      {issuing ? (
        <IssueToken
          onCancel={() => setIssuing(false)}
          onIssued={(token, record) => {
            setCreated({ token, label: record.label });
            onToken(token);
            setIssuing(false);
            void load();
          }}
        />
      ) : (
        <div className="flex">
          <Button variant="primary" onClick={() => setIssuing(true)}>
            <Plus className="size-3.5" /> New MCP token
          </Button>
        </div>
      )}
      {error && <Alert>{error}</Alert>}
      {tokens && tokens.length === 0 && !issuing && <EmptyState title="No MCP tokens" hint="Issue one for an agent, then paste it into the client config above." compact />}
      {tokens && tokens.length > 0 && (
        <Card className="overflow-hidden p-0">
          {tokens.map((t) => {
            const st = state(t);
            return (
              <div key={t.id} className="flex items-start gap-3 border-b border-hair px-4 py-2.5 last:border-b-0 hover:bg-sf2">
                <KeyRound className="mt-0.5 size-4 shrink-0 text-t3" strokeWidth={1.8} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 text-[13px] font-semibold text-t1">
                    <span className="truncate">{t.label}</span>
                    <code className="font-mono text-[11px] font-normal text-t3">…{t.hint}</code>
                    {st && <Badge tone={st.tone}>{st.label}</Badge>}
                    {all && t.userName && <Badge tone="muted">{t.userName}</Badge>}
                  </div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {t.scopes.map((scope) => (
                      <Badge key={scope} tone="muted" className="font-mono font-medium" title={MCP_TOKEN_SCOPE_LABELS[scope]}>
                        {scope}
                      </Badge>
                    ))}
                  </div>
                  <div className="mt-1 text-[11px] text-t3">
                    Issued {timeAgo(t.createdAt)} · {t.lastUsedAt ? `last used ${timeAgo(t.lastUsedAt)}` : 'never used'} · {Date.parse(t.expiresAt) <= Date.now() ? 'expired' : 'expires'} {new Date(t.expiresAt).toLocaleDateString()} · id{' '}
                    <code className="font-mono">{t.id}</code>
                  </div>
                </div>
                {confirm === t.id ? (
                  <span role="alertdialog" aria-label={`${st ? 'Remove' : 'Revoke'} ${t.label}?`} className="flex items-center gap-1 animate-fade-up">
                    <Button size="sm" variant="danger" onClick={() => void (st ? remove(t) : revoke(t))}>
                      {st ? 'Remove' : 'Revoke'}
                    </Button>
                    <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(undefined)} aria-label="Keep">
                      <X className="size-3.5" />
                    </Button>
                  </span>
                ) : (
                  <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(t.id)} aria-label={`${st ? 'Remove' : 'Revoke'} ${t.label}`} title={st ? `Remove this ${st.label} token's row` : 'Revoke'}>
                    {st ? <X className="size-3.5" /> : <Trash2 className="size-3.5" />}
                  </Button>
                )}
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}

// ---- grants ------------------------------------------------------------------------------

interface Pickers {
  users: UserView[];
  projects: Array<{ id: string; name: string; type: string }>;
  plugins: PluginSummary[];
  credentials: CredentialSummary[];
  tokens: McpTokenView[];
}

const KIND_LABELS: Record<McpGrantSubjectKind, string> = { user: 'User', group: 'Group (SCIM)', project: 'Project', role: 'Role', token: 'One MCP token' };

function GrantForm({ pickers, tools, onDone }: { pickers: Pickers; tools: McpToolsResponse['tools']; onDone: (saved?: McpToolGrant) => void }) {
  const [kind, setKind] = useState<McpGrantSubjectKind>('role');
  const [subjectId, setSubjectId] = useState('member');
  const [pluginId, setPluginId] = useState(pickers.plugins[0]?.id ?? 'core');
  const [allTools, setAllTools] = useState(true);
  const [toolText, setToolText] = useState('');
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<'default' | McpApprovalMode>('default');
  const [busy, setBusy] = useState(false);

  const pluginTools = useMemo(() => tools.filter((t) => t.pluginId === pluginId), [tools, pluginId]);
  const credentialTypes = useMemo(() => [...new Set(pluginTools.flatMap((t) => t.credentials ?? []))], [pluginTools]);
  const credentialsFor = (type: string) => pickers.credentials.filter((c) => c.type === type || c.type.endsWith(`.${type}`));

  const changeKind = (k: McpGrantSubjectKind) => {
    setKind(k);
    setSubjectId(k === 'role' ? 'member' : k === 'user' ? (pickers.users[0]?.id ?? '') : k === 'project' ? (pickers.projects[0]?.id ?? '') : k === 'token' ? (pickers.tokens[0]?.id ?? '') : '');
  };

  const submit = async () => {
    setBusy(true);
    try {
      const list = toolText
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      const body = { subject: { kind, id: subjectId }, pluginId, tools: allTools ? '*' : list, credentials, approval: approval === 'default' ? null : approval };
      const r = await api<{ grant: McpToolGrant }>('/api/mcp/grants', { method: 'POST', json: body });
      toast.success('Grant created');
      onDone(r.grant);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="px-5 py-4">
      <div className="mb-3 flex items-center gap-2">
        <SectionLabel>New grant</SectionLabel>
        <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={() => onDone()} aria-label="Close">
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>Who</FieldLabel>
          <Select value={kind} onChange={(e) => changeKind(e.target.value as McpGrantSubjectKind)}>
            {MCP_GRANT_SUBJECT_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <FieldLabel>{KIND_LABELS[kind]}</FieldLabel>
          {kind === 'role' ? (
            <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              <option value="member">Members (everyone)</option>
              <option value="admin">Admins</option>
              <option value="owner">The owner</option>
            </Select>
          ) : kind === 'user' ? (
            <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {pickers.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.email})
                </option>
              ))}
            </Select>
          ) : kind === 'project' ? (
            <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {pickers.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          ) : kind === 'token' ? (
            <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              {pickers.tokens.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label} (…{t.hint}{t.userName ? `, ${t.userName}` : ''})
                </option>
              ))}
            </Select>
          ) : (
            <Input value={subjectId} onChange={(e) => setSubjectId(e.target.value)} placeholder="SCIM group id" spellCheck={false} />
          )}
        </div>
        <div>
          <FieldLabel>Plugin</FieldLabel>
          <Select value={pluginId} onChange={(e) => setPluginId(e.target.value)}>
            {pickers.plugins.map((p) => (
              <option key={p.id} value={p.id}>
                {p.info.name} ({p.id})
              </option>
            ))}
            {!pickers.plugins.some((p) => p.id === 'core') && <option value="core">Core nodes (core)</option>}
          </Select>
        </div>
        <div>
          <FieldLabel>Approval by a person</FieldLabel>
          <Select value={approval} onChange={(e) => setApproval(e.target.value as typeof approval)} aria-label="Approval by a person">
            <option value="default">Instance default (destructive tools)</option>
            {MCP_APPROVAL_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {MCP_APPROVAL_LABELS[mode]}
              </option>
            ))}
          </Select>
        </div>
        <div className="sm:col-span-2">
          <div className="flex items-center gap-2">
            <Switch checked={allTools} onChange={setAllTools} label="Every tool of the plugin" />
            <span className="text-[13px] text-t2">Every tool of the plugin{pluginTools.length ? ` (${pluginTools.length} today)` : ''}</span>
          </div>
          {!allTools && (
            <div className="mt-2">
              <FieldLabel>Tool names (space or comma separated; !name excludes)</FieldLabel>
              <Input value={toolText} onChange={(e) => setToolText(e.target.value)} placeholder={pluginTools.slice(0, 3).map((t) => t.name).join(' ') || 'message_send !message_delete'} spellCheck={false} />
              {pluginTools.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {pluginTools.slice(0, 40).map((t) => (
                    <button key={t.name} type="button" className="rounded-md border border-hair bg-wl px-1.5 py-0.5 font-mono text-[11px] text-t2 hover:bg-sf2" onClick={() => setToolText((s) => (s ? `${s} ${t.name}` : t.name))} title={t.description}>
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {credentialTypes.map((type) => (
          <div key={type}>
            <FieldLabel>Credential for {type}</FieldLabel>
            <Select value={credentials[type] ?? ''} onChange={(e) => setCredentials((c) => (e.target.value ? { ...c, [type]: e.target.value } : Object.fromEntries(Object.entries(c).filter(([k]) => k !== type))))}>
              <option value="">None (tools needing it answer with what is missing)</option>
              {credentialsFor(type).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => onDone()}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} loading={busy} disabled={!subjectId || !pluginId}>
          Create grant
        </Button>
      </div>
    </Card>
  );
}

function GrantsCard({ tools, tokens }: { tools: McpToolsResponse['tools']; tokens: McpTokenView[] }) {
  const [grants, setGrants] = useState<McpToolGrant[]>();
  const [pickers, setPickers] = useState<Pickers>();
  const [adding, setAdding] = useState(false);
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState<string>();

  const load = useCallback(async () => {
    try {
      const [g, users, projects, plugins, credentials] = await Promise.all([
        api<{ grants: McpToolGrant[] }>('/api/mcp/grants'),
        api<{ users: UserView[] }>('/api/users').catch(() => ({ users: [] as UserView[] })),
        api<{ projects: Pickers['projects'] }>('/api/projects').catch(() => ({ projects: [] as Pickers['projects'] })),
        api<{ plugins: PluginSummary[] }>('/api/plugins').catch(() => ({ plugins: [] as PluginSummary[] })),
        api<{ credentials: CredentialSummary[] }>('/api/credentials').catch(() => ({ credentials: [] as CredentialSummary[] })),
      ]);
      setGrants(g.grants);
      setPickers({ users: users.users, projects: projects.projects, plugins: plugins.plugins, credentials: credentials.credentials, tokens });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [tokens]);
  useEffect(() => void load(), [load]);

  const setApprovalMode = async (grant: McpToolGrant, value: 'default' | McpApprovalMode) => {
    try {
      await api(`/api/mcp/grants/${encodeURIComponent(grant.id)}`, { method: 'PATCH', json: { approval: value === 'default' ? null : value } });
      toast.success('Approval setting saved');
    } catch (e) {
      toast.error((e as Error).message);
    }
    await load();
  };

  const remove = async (grant: McpToolGrant) => {
    setConfirm(undefined);
    try {
      await api(`/api/mcp/grants/${encodeURIComponent(grant.id)}`, { method: 'DELETE' });
      toast.success('Grant removed');
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Tool grants</SectionLabel>
      </div>
      <p className="text-[13px] text-t2">
        Who may list and call which tools, and which credential each tool uses. Without a grant an agent sees no tools. Governance’s allowed nodes (instance and project) still apply, and
        destructive tools wait for a person’s OK unless the grant says otherwise (only whoever created a grant can turn its approvals down).
      </p>
      {error && <Alert>{error}</Alert>}
      {adding && pickers ? (
        <GrantForm
          pickers={pickers}
          tools={tools}
          onDone={(saved) => {
            setAdding(false);
            if (saved) void load();
          }}
        />
      ) : (
        <div className="flex">
          <Button variant="primary" onClick={() => setAdding(true)} disabled={!pickers}>
            <Plus className="size-3.5" /> New grant
          </Button>
        </div>
      )}
      {grants && grants.length === 0 && !adding && <EmptyState title="No grants yet" hint="Agents see no tools until a grant names them. Start with “Members → every tool of a plugin”." compact />}
      {grants && grants.length > 0 && (
        <Card className="overflow-hidden p-0">
          {grants.map((g) => (
            <div key={g.id} className="flex items-start gap-3 border-b border-hair px-4 py-2.5 last:border-b-0 hover:bg-sf2">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-t3" strokeWidth={1.8} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-t1">
                  <Badge tone="accent">{KIND_LABELS[g.subject.kind]}</Badge>
                  <span className="font-semibold">{g.subject.name ?? g.subject.id}</span>
                  <span className="text-t3">→</span>
                  <code className="font-mono text-[12px]">{g.pluginId}</code>
                  <Select
                    value={g.approval ?? 'default'}
                    onChange={(e) => void setApprovalMode(g, e.target.value as 'default' | McpApprovalMode)}
                    aria-label={`Approval for ${g.subject.name ?? g.subject.id} on ${g.pluginId}`}
                    className="h-7 w-auto py-0 text-[12px]"
                  >
                    <option value="default">Approval: instance default</option>
                    {MCP_APPROVAL_MODES.map((mode) => (
                      <option key={mode} value={mode}>
                        Approval: {MCP_APPROVAL_LABELS[mode].toLowerCase()}
                      </option>
                    ))}
                  </Select>
                </div>
                <div className="mt-1 flex flex-wrap gap-1">
                  {g.tools === '*' ? (
                    <Badge tone="success" className="font-mono">
                      * every tool
                    </Badge>
                  ) : (
                    g.tools.map((t) => (
                      <Badge key={t} tone={t.startsWith('!') ? 'danger' : 'muted'} className="font-mono font-medium">
                        {t}
                      </Badge>
                    ))
                  )}
                </div>
                <div className="mt-1 text-[11px] text-t3">
                  {Object.keys(g.credentials).length ? `Credentials: ${Object.entries(g.credentials).map(([type, id]) => `${type} → ${pickers?.credentials.find((c) => c.id === id)?.name ?? id}`).join(', ')}` : 'No credentials bound'} · created {timeAgo(g.createdAt)}
                </div>
              </div>
              {confirm === g.id ? (
                <span role="alertdialog" aria-label="Remove this grant?" className="flex items-center gap-1 animate-fade-up">
                  <Button size="sm" variant="danger" onClick={() => void remove(g)}>
                    Remove
                  </Button>
                  <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(undefined)} aria-label="Keep">
                    <X className="size-3.5" />
                  </Button>
                </span>
              ) : (
                <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(g.id)} aria-label="Remove grant" title="Remove">
                  <Trash2 className="size-3.5" />
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}

// ---- approvals ---------------------------------------------------------------------------

/** MCP tool calls waiting for a person (lib/server/mcp/approvals.ts), refreshed while the page is open. */
function ApprovalsCard() {
  const [approvals, setApprovals] = useState<McpApprovalView[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      setApprovals((await api<{ approvals: McpApprovalView[] }>('/api/mcp/approvals')).approvals);
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 4000);
    return () => clearInterval(timer);
  }, [load]);

  const decide = async (approval: McpApprovalView, approve: boolean) => {
    setBusy(approval.id);
    try {
      await api(`/api/mcp/approvals/${encodeURIComponent(approval.id)}`, { method: 'POST', json: { approve } });
      toast.success(approve ? 'Approved: the agent can repeat the call' : 'Denied');
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(undefined);
      await load();
    }
  };

  const pending = (approvals ?? []).filter((a) => a.status === 'pending');
  const recent = (approvals ?? []).filter((a) => a.status !== 'pending').slice(0, 8);
  return (
    <div className="space-y-3" id="mcp-approvals">
      <div className="flex items-center gap-2">
        <ShieldAlert className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Approvals</SectionLabel>
        {pending.length > 0 && (
          <Badge tone="warning" className="ml-auto">
            {pending.length} waiting
          </Badge>
        )}
      </div>
      <p className="text-[13px] text-t2">
        Destructive tools (and any a grant says so) wait for a person. Clients that support MCP elicitation ask their own user; for the rest, the call lands here. Whoever answers must be an
        admin, the person the agent acts for, or share a project with them. An approval lets the agent repeat the same call once, within ten minutes.
      </p>
      {error && <Alert>{error}</Alert>}
      {approvals && pending.length === 0 && <EmptyState title="Nothing waiting" hint="Calls that need a person show up here as they come in." compact />}
      {pending.length > 0 && (
        <Card className="overflow-hidden p-0">
          {pending.map((a) => (
            <div key={a.id} className="flex items-start gap-3 border-b border-hair px-4 py-2.5 last:border-b-0">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" strokeWidth={1.8} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-t1">
                  <code className="font-mono text-[12px] font-semibold">{a.tool}</code>
                  <span className="text-t3">of</span>
                  <code className="font-mono text-[12px]">{a.pluginId}</code>
                  <span className="text-t3">for</span>
                  <span>{a.caller}</span>
                  <span className="text-[11px] text-t3">asked {timeAgo(a.createdAt)}</span>
                </div>
                <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded-[8px] border border-hair bg-wl px-2.5 py-1.5 font-mono text-[12px] text-t1">{a.summary}</pre>
              </div>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="primary" disabled={busy === a.id || !a.canDecide} onClick={() => void decide(a, true)}>
                  Approve
                </Button>
                <Button size="sm" variant="danger" disabled={busy === a.id || !a.canDecide} onClick={() => void decide(a, false)}>
                  Deny
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}
      {recent.length > 0 && (
        <div className="space-y-1 text-[12px] text-t3">
          {recent.map((a) => (
            <div key={a.id}>
              <Badge tone={a.status === 'denied' ? 'danger' : a.status === 'expired' ? 'muted' : 'success'}>{a.status}</Badge> <code className="font-mono">{a.tool}</code> for {a.caller}
              {a.decidedBy ? ` · ${a.decidedBy}` : ''} · {timeAgo(a.decidedAt ?? a.createdAt)}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- tool browser --------------------------------------------------------------------------

function ToolBrowser({ data, unavailable }: { data?: McpToolsResponse; unavailable?: string }) {
  const [filter, setFilter] = useState('');
  const [plugin, setPlugin] = useState('');
  const [open, setOpen] = useState<string>();
  const tools = useMemo(() => (data?.tools ?? []).filter((t) => (!plugin || t.pluginId === plugin) && (!filter || `${t.name} ${t.gatewayName} ${t.title} ${t.description}`.toLowerCase().includes(filter.toLowerCase()))), [data, plugin, filter]);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Wrench className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Tools</SectionLabel>
        {data && (
          <Badge tone="muted" className="ml-auto">
            {data.tools.length} tools · {data.plugins.length} plugins
          </Badge>
        )}
      </div>
      {!data ? (
        <EmptyState title="No tools to show yet" hint={unavailable ?? 'The tool list (GET /api/mcp/tools) lands with the per-plugin MCP endpoints in this release; grants and tokens work already.'} compact />
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter tools…" className="max-w-xs" />
            <Select value={plugin} onChange={(e) => setPlugin(e.target.value)} className="max-w-xs">
              <option value="">Every plugin</option>
              {data.plugins.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.tools})
                </option>
              ))}
            </Select>
          </div>
          {tools.length === 0 ? (
            <EmptyState title="No tools match" compact />
          ) : (
            <Card className="overflow-hidden p-0">
              {tools.slice(0, 200).map((t) => {
                const key = `${t.pluginId}/${t.name}`;
                return (
                  <div key={key} className="border-b border-hair px-4 py-2.5 last:border-b-0">
                    <button type="button" className="flex w-full items-start gap-3 text-left" onClick={() => setOpen(open === key ? undefined : key)}>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5 text-[13px] text-t1">
                          <code className="font-mono font-semibold">{t.gatewayName}</code>
                          <span className="text-t3">{t.title}</span>
                          {t.annotations.readOnlyHint && <Badge tone="muted">read-only</Badge>}
                          {t.annotations.destructiveHint && <Badge tone="danger">destructive</Badge>}
                        </div>
                        <div className="mt-0.5 line-clamp-2 text-[12px] text-t2">{t.description}</div>
                        <div className="mt-0.5 text-[11px] text-t3">
                          {t.pluginName} · <code className="font-mono">{t.name}</code> on {`/api/mcp/plugins/${t.pluginId}`}
                        </div>
                      </div>
                    </button>
                    {open === key && <pre className="mt-2 max-h-72 overflow-auto rounded-[10px] border border-hair bg-wl px-3 py-2 font-mono text-[11px] leading-relaxed text-t1">{JSON.stringify(t.inputSchema, null, 2)}</pre>}
                  </div>
                );
              })}
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// ---- the instance MCP server (coding agents) --------------------------------------------------

function InstanceServerCard({ origin }: { origin: string }) {
  const [access, setAccess] = useState<McpAccessView>();
  const [token, setToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'toggle' | 'token'>();

  useEffect(() => {
    api<{ access: McpAccessView }>('/api/settings/mcp')
      .then((r) => setAccess(r.access))
      .catch((e: Error) => setError(e.message));
  }, []);

  const apply = (response: McpAccessResponse) => {
    setAccess(response.access);
    if (response.token) setToken(response.token);
  };
  const toggle = async (enabled: boolean) => {
    setBusy('toggle');
    try {
      apply(await api<McpAccessResponse>('/api/settings/mcp', { method: 'PATCH', json: { enabled } }));
      toast.success(enabled ? 'Instance MCP server on' : 'Instance MCP server off');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const regenerate = async () => {
    if (access?.hasToken && !window.confirm('Replace the access token? Clients using the current one stop working at once.')) return;
    setBusy('token');
    try {
      apply(await api<McpAccessResponse>('/api/settings/mcp', { method: 'POST' }));
      toast.success('New access token created');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (error && !access) return <Alert>{error}</Alert>;
  if (!access) return <div className="h-24 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  const url = `${origin}${access.path}`;
  const shown = token ?? PLACEHOLDER;
  const command = `claude mcp add --transport http landflow-instance ${url} --header "Authorization: Bearer ${shown}"`;
  return (
    <Card className="space-y-3 px-5 py-4">
      <div className="flex items-center gap-2">
        <Plug className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>Instance MCP server (build workflows)</SectionLabel>
      </div>
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] leading-relaxed text-t2">
          Lets coding agents such as Claude Code build, validate and run workflows here (owners and admins). It serves <span className="font-mono text-[12px] text-t1">{url}</span> with its own access token, separate from the
          plugin tools above.
        </p>
        <Switch checked={access.enabled} onChange={(v) => void toggle(v)} disabled={busy === 'toggle'} label="Instance MCP server" />
      </div>
      {(access.enabled || access.hasToken) && (
        <>
          {token ? (
            <div className="space-y-2">
              <Alert tone="warning">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Copy the token now. It isn’t stored and won’t be shown again.
              </Alert>
              <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1">{token}</code>
                <CopyButton text={token} label="Copy token" />
              </div>
            </div>
          ) : (
            <p className="text-[12px] text-t3">
              {access.hasToken ? (
                <>
                  A token ending in <span className="font-mono text-t1">…{access.tokenHint}</span> is in use{access.tokenCreatedAt && <> since {new Date(access.tokenCreatedAt).toLocaleString()}</>}. It was shown once; regenerate it if you
                  need it again.
                </>
              ) : (
                'No token yet.'
              )}
            </p>
          )}
          <div className="flex items-center justify-between gap-3">
            <code className="min-w-0 truncate font-mono text-[11px] text-t3">{command}</code>
            <Button size="sm" onClick={regenerate} loading={busy === 'token'}>
              <RefreshCw className="size-3.5" /> {access.hasToken ? 'Regenerate token' : 'Create token'}
            </Button>
          </div>
        </>
      )}
      {error && <Alert>{error}</Alert>}
    </Card>
  );
}

// ---- the page ------------------------------------------------------------------------------------

export function McpSettings() {
  const [status, setStatus] = useState<McpStatusView>();
  const [tools, setTools] = useState<McpToolsResponse>();
  const [toolsUnavailable, setToolsUnavailable] = useState<string>();
  const [tokens, setTokens] = useState<McpTokenView[]>([]);
  const [issued, setIssued] = useState<string>();
  const [error, setError] = useState<string>();
  const [origin, setOrigin] = useState('http://localhost:3000');

  useEffect(() => {
    setOrigin(window.location.origin);
    api<McpStatusView>('/api/mcp/status')
      .then(setStatus)
      .catch((e: Error) => setError(e.message));
    api<McpToolsResponse>('/api/mcp/tools')
      .then(setTools)
      .catch((e: Error) => setToolsUnavailable(/404|not found/i.test(e.message) ? undefined : e.message));
    api<{ tokens: McpTokenView[] }>('/api/mcp/tokens?all=1')
      .then((r) => setTokens(r.tokens))
      .catch(() => {});
  }, []);

  if (!status) return error ? <Alert>{error}</Alert> : <div className="h-36 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;

  return (
    <div className="space-y-6">
      <GatewayCard status={status} />
      <ConnectCard status={status} token={issued} plugins={tools?.plugins ?? []} />
      <TokensCard canManage={status.canManage} onToken={setIssued} />
      {status.canManage && <GrantsCard tools={tools?.tools ?? []} tokens={tokens} />}
      <ApprovalsCard />
      <ToolBrowser data={tools} unavailable={toolsUnavailable} />
      {status.canManage && <InstanceServerCard origin={origin} />}
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
