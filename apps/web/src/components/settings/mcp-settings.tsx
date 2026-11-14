'use client';
/**
 * Settings → MCP, in four collapsed sections (mcp-sections.tsx): Access token (the instance MCP server's switch and token,
 * your Landflow-issued MCP tokens), Connected clients (how to connect an agent), Tools (the tool scopes, the plugin tool
 * browser, grants, approvals) and Gateway (mcp-gateway.tsx). This file holds the tokens, the connect card, the tool browser,
 * the instance server card and the page; the grants and approvals are in mcp-grants.tsx.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { KeyRound, Plug, Plus, RefreshCw, ShieldAlert, Trash2, TriangleAlert, Wrench, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { MCP_TOKEN_SCOPE_LABELS, MCP_TOKEN_SCOPES, type McpAccessResponse, type McpAccessView, type McpStatusView, type McpTokenScope, type McpTokenView, type McpToolsResponse } from '@/lib/shared/mcp';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { confirmAction } from '@/components/ui/confirm';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, SectionLabel, Select, Switch } from '@/components/ui/inputs';
import { Alert, PLACEHOLDER, Snippet } from './mcp-common';
import { GatewayCard } from './mcp-gateway';
import { ApprovalsCard, GrantsCard, useMcpApprovals } from './mcp-grants';
import { McpSections } from './mcp-sections';


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
  const [projectId, setProjectId] = useState('');
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ projects: Array<{ id: string; name: string }> }>('/api/projects')
      .then((r) => setProjects(r.projects))
      .catch(() => setProjects([]));
  }, []);
  const toggle = (scope: McpTokenScope) => setScopes((s) => (s.includes(scope) ? s.filter((x) => x !== scope) : [...s, scope]));
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ token: string; record: McpTokenView }>('/api/mcp/tokens', { method: 'POST', json: { label, scopes, expiresInDays: Number(days) || 30, ...(projectId && { projectId }) } });
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
          <FieldLabel>Project (optional)</FieldLabel>
          <div className="max-w-[360px]">
            <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} aria-label="Project">
              <option value="">Every project I can see</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <p className="mt-1 text-[12px] text-t3">A project token makes the instance MCP server (coding agents) list and change only that project’s workflows. The plugin endpoints are not affected.</p>
        </div>
        <div className="sm:col-span-2">
          <FieldLabel>Scopes</FieldLabel>
          <div className="flex flex-wrap gap-3">
            {MCP_TOKEN_SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-[13px] text-t2">
                <input type="checkbox" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />
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
              <span className="font-semibold text-t1">Copy “{created.label}” now.</span> You won’t see this token again; Landflow keeps only a hash of it. The snippets under Connected clients are filled in with it.
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
      {tokens && tokens.length === 0 && !issuing && <EmptyState title="No MCP tokens" hint="Issue one for an agent, then paste it into the client config under Connected clients." compact />}
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
                    {t.projectId && <Badge tone="accent" title={`Scoped to the project ${t.projectName ?? t.projectId}`}>project: {t.projectName ?? t.projectId}</Badge>}
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
    if (access?.hasToken && !(await confirmAction('Replace the access token? Clients using the current one stop working at once.', { action: 'Replace', danger: true }))) return;
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
          plugin tools under Tools.
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

  // Pending approvals: the server sends people here (Settings → MCP → Approvals), so the Tools section opens when one waits.
  // One poll feeds both that count and the Approvals card.
  const approvals = useMcpApprovals();
  const pending = (approvals.approvals ?? []).filter((a) => a.status === 'pending').length;

  if (!status) return error ? <Alert>{error}</Alert> : <div className="h-36 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;

  return (
    <div className="space-y-4">
      <McpSections
        canManage={status.canManage}
        gatewayMode={status.gateway.mode}
        pendingApprovals={pending}
        access={
          <>
            {status.canManage && <InstanceServerCard origin={origin} />}
            <TokensCard canManage={status.canManage} onToken={setIssued} />
          </>
        }
        clients={<ConnectCard status={status} token={issued} plugins={tools?.plugins ?? []} />}
        tools={
          <>
            <ToolBrowser data={tools} unavailable={toolsUnavailable} />
            {status.canManage && <GrantsCard tools={tools?.tools ?? []} tokens={tokens} />}
            <ApprovalsCard {...approvals} />
          </>
        }
        gateway={<GatewayCard status={status} />}
      />
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
