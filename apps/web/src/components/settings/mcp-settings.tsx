'use client';
/**
 * Settings → MCP: the instance MCP server at /api/mcp, for coding agents such as Claude Code. On/off,
 * the access token (shown once when it is created; regenerate to get a new one) and the client config
 * to paste, built from this page's origin.
 */
import { useEffect, useState } from 'react';
import { KeyRound, Plug, RefreshCw, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import type { McpAccessResponse, McpAccessView } from '@/lib/shared/mcp';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { CopyButton } from '@/components/ui/copy-button';
import { SectionLabel, Switch } from '@/components/ui/inputs';

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

export function McpSettings() {
  const [access, setAccess] = useState<McpAccessView>();
  const [token, setToken] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<'toggle' | 'token'>();
  const [origin, setOrigin] = useState('http://localhost:3000');

  useEffect(() => {
    setOrigin(window.location.origin);
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
    setError(undefined);
    try {
      apply(await api<McpAccessResponse>('/api/settings/mcp', { method: 'PATCH', json: { enabled } }));
      toast.success(enabled ? 'MCP server on' : 'MCP server off');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  const regenerate = async () => {
    if (access?.hasToken && !window.confirm('Replace the access token? Clients using the current one stop working at once.')) return;
    setBusy('token');
    setError(undefined);
    try {
      apply(await api<McpAccessResponse>('/api/settings/mcp', { method: 'POST' }));
      toast.success('New access token created');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };

  if (!access) {
    return error ? (
      <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>
    ) : (
      <div className="h-36 rounded-2xl border border-hair bg-sf animate-pulse-soft" />
    );
  }

  const url = `${origin}${access.path}`;
  const shown = token ?? PLACEHOLDER;
  const command = `claude mcp add --transport http landflow ${url} --header "Authorization: Bearer ${shown}"`;
  const config = JSON.stringify({ mcpServers: { landflow: { type: 'http', url, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2);

  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <Plug className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Landflow MCP server</SectionLabel>
        </div>
        <div className="flex items-start justify-between gap-4">
          <p className="text-[13px] leading-relaxed text-t2">
            Lets coding agents such as Claude Code build, validate and run workflows here: list and edit workflows, look up node types and their parameters,
            execute a workflow and read its executions. It serves <span className="font-mono text-[12px] text-t1">{url}</span> over Streamable HTTP.
          </p>
          <Switch checked={access.enabled} onChange={(v) => void toggle(v)} disabled={busy === 'toggle'} label="MCP server" />
        </div>
        {!access.enabled && <p className="mt-3 text-[12px] text-t3">Off: the endpoint answers 403 to every request.</p>}
      </Card>

      {(access.enabled || access.hasToken) && (
        <Card className="px-5 py-4">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound className="size-4 text-t3" strokeWidth={1.8} />
            <SectionLabel>Access token</SectionLabel>
          </div>
          {token ? (
            <div className="space-y-2">
              <div className="flex gap-2 rounded-[10px] border border-warnbd bg-warndim px-3 py-2.5 text-[12px] text-warn">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> Copy the token now. It isn’t stored and won’t be shown again.
              </div>
              <div className="flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-3 pr-1">
                <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1">{token}</code>
                <CopyButton text={token} label="Copy token" />
              </div>
            </div>
          ) : (
            <p className="text-[13px] text-t2">
              {access.hasToken ? (
                <>
                  A token ending in <span className="font-mono text-t1">…{access.tokenHint}</span> is in use
                  {access.tokenCreatedAt && <> since {new Date(access.tokenCreatedAt).toLocaleString()}</>}. It was shown once; regenerate it if you need it
                  again.
                </>
              ) : (
                'No token yet.'
              )}
            </p>
          )}
          <div className="mt-3 flex justify-end">
            <Button size="sm" onClick={regenerate} loading={busy === 'token'}>
              <RefreshCw className="size-3.5" /> {access.hasToken ? 'Regenerate token' : 'Create token'}
            </Button>
          </div>
        </Card>
      )}

      {access.enabled && (
        <Card className="space-y-4 px-5 py-4">
          <SectionLabel>Connect a client</SectionLabel>
          <Snippet label="Claude Code command" text={command} />
          <Snippet label="Project .mcp.json" text={config} />
          {!token && <p className="text-[12px] text-t3">Replace {PLACEHOLDER} with the access token. Regenerate it to fill it in here.</p>}
        </Card>
      )}

      {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up">{error}</div>}
    </div>
  );
}
