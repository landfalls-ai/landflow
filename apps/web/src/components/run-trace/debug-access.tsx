'use client';
/**
 * "Debug access" on the Run Trace page: mint, list and revoke the debug tokens of one execution
 * (docs/specs/19-debug-token.md). The token is shown once, with what to give an agent; the list never has it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, TriangleAlert, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { cn } from '@/lib/utils';
import { claudeAddCommand, curlCheck, DEBUG_TTL_CHOICES, mcpConfigJson, relativeTime, tokenPrefix, tokenState } from '@/lib/shared/debug-token-snippets';
import { Badge, type Tone } from '../ui/badge';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { FieldLabel, Input, Select, Switch, Textarea } from '../ui/inputs';
import { useViewer } from '../auth/viewer';

type Scope = 'executions:read' | 'trace:read' | 'runs:debug';
interface RunNode {
  id: string;
  name: string;
}
interface OverrideSettings {
  enabled: boolean;
  allowedHosts: string[];
}
interface TokenRecord {
  id: string;
  hint: string;
  label: string;
  scopes: Scope[];
  nodeName?: string;
  expiresAt: string;
  revokedAt?: string;
  lastUsedAt?: string;
  uses: number;
}
interface MintedToken {
  token: string;
  record: TokenRecord;
  mcp: { enabled: boolean; path: string };
}

const MAX_USES = 1000;
const RUN_TTL_CHOICES = [
  { seconds: 300, label: '5 minutes' },
  { seconds: 900, label: '15 minutes' },
  { seconds: 3600, label: '1 hour' },
] as const;
const SCOPES: Array<{ id: Scope; name: string; hint: string }> = [
  { id: 'executions:read', name: 'Read the execution', hint: 'get_execution, explain_failure' },
  { id: 'trace:read', name: 'Read the trace', hint: 'get_run_trace' },
];
const TONE: Record<string, Tone> = { live: 'success', revoked: 'muted', expired: 'muted', 'used up': 'warning' };

export function DebugAccessButton({ executionId }: { executionId: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={button}
        type="button"
        onClick={() => setOpen(true)}
        className="ml-auto inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-hair px-3 text-[13px] font-semibold text-t2 hover:border-ac hover:text-ac"
      >
        <KeyRound className="size-4" /> <span>Debug access</span>
      </button>
      {open && (
        <DebugAccessDialog
          executionId={executionId}
          onClose={() => {
            setOpen(false);
            button.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

function DebugAccessDialog({ executionId, onClose }: { executionId: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [tokens, setTokens] = useState<TokenRecord[]>();
  const viewer = useViewer();
  const [scopes, setScopes] = useState<Scope[]>(['executions:read', 'trace:read']);
  const [runMode, setRunMode] = useState(false);
  const [nodes, setNodes] = useState<RunNode[]>();
  const [node, setNode] = useState('');
  const [override, setOverride] = useState<OverrideSettings>();
  const [hostsText, setHostsText] = useState('');
  const [savingOverride, setSavingOverride] = useState(false);
  const [ttl, setTtl] = useState(3600);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<MintedToken>();
  const [problem, setProblem] = useState<string>();
  const [revoking, setRevoking] = useState<string>();
  const base = `/api/executions/${executionId}/debug-tokens`;

  const load = useCallback(
    () =>
      api<{ tokens: TokenRecord[] }>(base)
        .then((r) => setTokens(r.tokens))
        .catch(() => {}),
    [base],
  );
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000); // so a token's last use shows while an agent works
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    api<OverrideSettings>('/api/settings/debug-node')
      .then((s) => {
        setOverride(s);
        setHostsText(s.allowedHosts.join('\n'));
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    if (!runMode || nodes) return;
    api<{ execution: { workflow?: { nodes: RunNode[] }; runData?: Record<string, unknown[]> } }>(`/api/executions/${executionId}`)
      .then(({ execution }) => {
        const ran = (execution.workflow?.nodes ?? []).filter((n) => execution.runData?.[n.id]?.length).map((n) => ({ id: n.id, name: n.name }));
        setNodes(ran);
        setNode((current) => current || ran.at(-1)?.name || '');
      })
      .catch(() => setNodes([]));
  }, [runMode, nodes, executionId]);
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);

  const mint = async () => {
    setBusy(true);
    setProblem(undefined);
    try {
      const result = await api<MintedToken>(base, {
        method: 'POST',
        json: runMode
          ? { scopes: ['runs:debug'], node, ttlSeconds: Math.min(ttl, 3600), ...(label.trim() && { label: label.trim() }) }
          : { scopes, ttlSeconds: ttl, ...(label.trim() && { label: label.trim() }) },
      });
      setMinted(result);
      setLabel('');
      void load();
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : 'Could not mint the token');
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    setRevoking(id);
    try {
      await api(`${base}/${id}`, { method: 'DELETE' });
      toast.success('Token revoked: it stops working on its next call');
      await load();
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Could not revoke the token');
    } finally {
      setRevoking(undefined);
    }
  };
  const saveOverride = async (patch: Partial<OverrideSettings>) => {
    setSavingOverride(true);
    try {
      const next = await api<OverrideSettings>('/api/settings/debug-node', { method: 'PATCH', json: patch });
      setOverride(next);
      setHostsText(next.allowedHosts.join('\n'));
      toast.success(patch.enabled === undefined ? 'Allowed hosts saved' : next.enabled ? 'Local node override is on' : 'Local node override is off');
    } catch (caught) {
      toast.error(caught instanceof Error ? caught.message : 'Could not save');
    } finally {
      setSavingOverride(false);
    }
  };
  const isOwner = viewer?.role === 'owner';
  const toggle = (id: Scope) => setScopes((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <>
      <div className="fixed inset-0 z-40 bg-overlay animate-in" onClick={onClose} aria-hidden />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label="Debug access"
        tabIndex={-1}
        className={cn(
          'fixed inset-x-0 bottom-0 z-50 flex max-h-[90dvh] flex-col rounded-t-3xl border border-hair bg-sf shadow-pop outline-none animate-fade-up',
          'md:inset-x-auto md:bottom-auto md:left-1/2 md:top-1/2 md:w-[520px] md:max-w-[calc(100vw-32px)] md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-2xl',
        )}
      >
        <div className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-bd md:hidden" aria-hidden />
        <header className="flex shrink-0 items-start gap-2 px-4 pb-2 pt-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[16px] font-semibold leading-tight text-t1">Debug access</h2>
            <p className="mt-1 text-[12px] leading-snug text-t3">A key an agent can use to read this one run: the trace and the failure, redacted. It cannot run or change anything. The optional debug run below is the one exception, and is off unless an owner turns it on.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid size-9 shrink-0 place-items-center rounded-full text-t2 hover:bg-acdim hover:text-t1">
            <X className="size-4" />
          </button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-contain px-4 pb-[max(20px,env(safe-area-inset-bottom))]">
          {minted ? (
            <Minted minted={minted} executionId={executionId} onDone={() => setMinted(undefined)} />
          ) : (
            <section className="flex flex-col gap-3" aria-label="New token">
              <div className={cn(runMode && 'opacity-40')} aria-disabled={runMode}>
                <FieldLabel>Can read</FieldLabel>
                <div className="flex flex-col gap-1.5">
                  {SCOPES.map((s) => (
                    <label key={s.id} className="flex cursor-pointer items-center gap-2.5 rounded-xl border border-hair px-3 py-2 text-[13px] has-[:checked]:border-ac">
                      <input type="checkbox" checked={scopes.includes(s.id)} disabled={runMode} onChange={() => toggle(s.id)} className="size-4 accent-[var(--ac2)]" />
                      <span className="min-w-0 flex-1">
                        <b className="block font-semibold text-t1">{s.name}</b>
                        <span className="block font-mono text-[11px] text-t3">{s.hint}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              <div className={cn('rounded-xl border px-3 py-2.5', runMode ? 'border-rd' : 'border-hair')} data-testid="run-scope">
                <label className={cn('flex items-start gap-2.5 text-[13px]', override?.enabled ? 'cursor-pointer' : 'opacity-60')}>
                  <input
                    type="checkbox"
                    className="mt-0.5 size-4 accent-[var(--ac2)]"
                    checked={runMode}
                    disabled={!override?.enabled}
                    onChange={(e) => {
                      setRunMode(e.target.checked);
                      if (e.target.checked) setTtl((t) => Math.min(t, 900));
                    }}
                  />
                  <span className="min-w-0 flex-1">
                    <b className="block font-semibold text-t1">Run one node on my local plugin (debug run)</b>
                    <span className="block font-mono text-[11px] text-t3">runs:debug · one node · works once</span>
                    {!override?.enabled && <span className="mt-1 block text-[12px] text-t3">Off: an owner turns on “Local node override” below first.</span>}
                  </span>
                </label>
                {runMode && (
                  <div className="mt-2.5 flex flex-col gap-2.5">
                    <p role="note" className="flex gap-2 rounded-lg bg-wl p-2.5 text-[12px] leading-snug text-rd">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                      <span>
                        This is not read-only. The host will <b>run code</b>: it calls the plugin URL you give, with this node&apos;s recorded input (unredacted) and its parameters, never credentials. The result is not saved to the run. It works once and cannot be combined with the read scopes.
                      </span>
                    </p>
                    <div>
                      <FieldLabel>Node to run</FieldLabel>
                      <Select value={node} onChange={(e) => setNode(e.target.value)} aria-label="Node to run">
                        {(nodes ?? []).map((n) => (
                          <option key={n.id} value={n.name}>
                            {n.name}
                          </option>
                        ))}
                      </Select>
                      {nodes && nodes.length === 0 && <p className="mt-1 text-[12px] text-t3">No node of this run has recorded input.</p>}
                    </div>
                  </div>
                )}
              </div>
              <div>
                <FieldLabel>Expires after</FieldLabel>
                <Select value={ttl} onChange={(e) => setTtl(Number(e.target.value))} aria-label="Expires after">
                  {(runMode ? RUN_TTL_CHOICES : DEBUG_TTL_CHOICES).map((c) => (
                    <option key={c.seconds} value={c.seconds}>
                      {c.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <FieldLabel>Label (optional)</FieldLabel>
                <Input value={label} maxLength={100} onChange={(e) => setLabel(e.target.value)} placeholder="For Claude Code" aria-label="Label" />
              </div>
              {problem && (
                <p role="alert" className="text-[12px] text-rd">
                  {problem}
                </p>
              )}
              <Button variant="primary" className="h-10 w-full" loading={busy} disabled={runMode ? !node : scopes.length === 0} onClick={mint}>
                {runMode ? 'Mint a one-use debug-run token' : 'Mint a token'}
              </Button>
            </section>
          )}
          <section aria-label="Local node override" className="rounded-xl border border-hair p-3" data-testid="override-settings">
            <div className="flex items-center gap-2">
              <h3 className="min-w-0 flex-1 text-[13px] font-semibold text-t1">Local node override</h3>
              <Badge tone={override?.enabled ? 'warning' : 'muted'}>{override ? (override.enabled ? 'on' : 'off') : '…'}</Badge>
              {isOwner && override && <Switch checked={override.enabled} disabled={savingOverride} label="Local node override" onChange={(enabled) => void saveOverride({ enabled })} />}
            </div>
            <p className="mt-1 text-[12px] leading-snug text-t3">Lets one node of a run be run against a plugin on a developer&apos;s machine. Off by default. The host calls only the hosts listed here, never anything else.</p>
            {isOwner ? (
              <div className="mt-2 flex flex-col gap-2">
                <FieldLabel className="mb-0">Allowed hosts (one per line: a tunnel name or localhost)</FieldLabel>
                <Textarea rows={3} value={hostsText} onChange={(e) => setHostsText(e.target.value)} placeholder={'127.0.0.1\nmy-tunnel.example.dev'} aria-label="Allowed hosts" className="font-mono text-[12px]" />
                <Button variant="outline" size="sm" className="h-9 w-full" loading={savingOverride} onClick={() => void saveOverride({ allowedHosts: hostsText.split(/\n|,/).map((h) => h.trim()).filter(Boolean) })}>
                  Save allowed hosts
                </Button>
              </div>
            ) : (
              <p className="mt-2 text-[12px] text-t3">Allowed hosts: {override?.allowedHosts.length ? override.allowedHosts.join(', ') : 'none'}. Only an owner changes this.</p>
            )}
          </section>
          <section aria-label="Tokens of this run">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.06em] text-t3">Tokens of this run{tokens ? ` · ${tokens.length}` : ''}</h3>
            {!tokens ? (
              <p className="text-[13px] text-t3">Loading…</p>
            ) : tokens.length === 0 ? (
              <p className="text-[13px] text-t3">None yet.</p>
            ) : (
              <ul className="divide-y divide-hair rounded-xl border border-hair">
                {tokens.map((t) => (
                  <TokenRow key={t.id} token={t} busy={revoking === t.id} onRevoke={() => revoke(t.id)} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </>
  );
}

function Minted({ minted, executionId, onDone }: { minted: MintedToken; executionId: string; onDone: () => void }) {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const { token, mcp } = minted;
  return (
    <section className="flex flex-col gap-3" aria-label="The new token">
      <div className="rounded-xl border border-ac bg-acdim p-3">
        <p className="mb-1.5 text-[12px] font-semibold text-t1">Copy it now: it is shown only once.</p>
        <div className="flex items-center gap-1">
          <code data-testid="debug-token" className="min-w-0 flex-1 break-all font-mono text-[12px] text-t1">
            {token}
          </code>
          <CopyButton text={token} label="Copy the token" />
        </div>
      </div>
      {minted.record.scopes.includes('runs:debug') ? (
        <>
          <p className="text-[12px] leading-snug text-rd">One use, for the node “{minted.record.nodeName}” only. The host calls the plugin URL you give, which must be on the owner&apos;s allowed list.</p>
          <Snippet
            title="Run the node (curl)"
            text={`curl -sS -X POST ${origin}/api/debug-node -H "Authorization: Bearer ${token}" -H "content-type: application/json" -d '${JSON.stringify({ executionId, node: minted.record.nodeName, pluginUrl: 'http://localhost:7392' })}'`}
          />
          <p className="text-[12px] text-t3">or let the CLI mint and spend its own: landflow debug-node {executionId} &quot;{minted.record.nodeName}&quot; --plugin-url http://localhost:7392</p>
        </>
      ) : (
        <>
          {!mcp.enabled && <p className="text-[12px] text-rd">The MCP server is off on this host, so the token has nothing to open until it is switched on.</p>}
          <Snippet title="Claude Code" text={claudeAddCommand(origin, mcp.path, token)} />
          <Snippet title=".mcp.json" text={mcpConfigJson(origin, mcp.path, token)} />
          <Snippet title="Check it with curl" text={curlCheck(origin, mcp.path, token)} />
        </>
      )}
      <Button variant="outline" className="h-10 w-full" onClick={onDone}>
        I have copied it
      </Button>
    </section>
  );
}

function Snippet({ title, text }: { title: string; text: string }) {
  return (
    <div className="min-w-0">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-[12px] font-semibold text-t2">{title}</span>
        <CopyButton text={text} label={`Copy ${title}`} />
      </div>
      <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-hair bg-wl p-2.5 font-mono text-[11px] leading-snug text-t1">{text}</pre>
    </div>
  );
}

function TokenRow({ token, busy, onRevoke }: { token: TokenRecord; busy: boolean; onRevoke: () => void }) {
  const state = tokenState(token, token.scopes.includes('runs:debug') ? 1 : MAX_USES);
  return (
    <li className="flex flex-col gap-1.5 px-3 py-2.5 text-[13px]" data-state={state}>
      <div className="flex items-center gap-2">
        <code className="font-mono text-[12px] text-t1">{tokenPrefix(token.hint)}</code>
        <Badge tone={TONE[state]}>{state}</Badge>
        <span className="min-w-0 flex-1 truncate text-right text-[12px] text-t3">{token.nodeName ? `${token.label} · ${token.nodeName}` : token.label}</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {token.scopes.map((s) => (
          <Badge key={s} tone="muted">
            {s}
          </Badge>
        ))}
      </div>
      <dl className="grid grid-cols-[72px_1fr] gap-x-2 gap-y-0.5 text-[12px]">
        <dt className="text-t3">{state === 'expired' ? 'Expired' : 'Expires'}</dt>
        <dd className="text-t1">{relativeTime(token.expiresAt)}</dd>
        <dt className="text-t3">Last used</dt>
        <dd className="text-t1">{token.lastUsedAt ? `${relativeTime(token.lastUsedAt)} · ${token.uses} call${token.uses === 1 ? '' : 's'}` : 'never'}</dd>
      </dl>
      {state === 'live' && (
        <Button variant="danger" size="sm" className="h-9 w-full" loading={busy} onClick={onRevoke}>
          Revoke
        </Button>
      )}
    </li>
  );
}
