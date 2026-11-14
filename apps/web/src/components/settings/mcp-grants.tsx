'use client';
/** Settings → MCP → Tools: who may use which tools (grants, owners and admins) and the approvals of destructive tool calls. */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Plus, ShieldAlert, ShieldCheck, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { UserView } from '@/lib/shared/auth';
import { MCP_GRANT_SUBJECT_KINDS, type McpGrantSubjectKind, type McpTokenView, type McpToolGrant, type McpToolsResponse } from '@/lib/shared/mcp';
import { MCP_APPROVAL_LABELS, MCP_APPROVAL_MODES, type McpApprovalMode, type McpApprovalView } from '@/lib/shared/mcp-approval';
import type { CredentialSummary, PluginSummary } from '@/lib/shared/types';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, SectionLabel, Select, Switch } from '@/components/ui/inputs';
import { Alert } from './mcp-common';

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

export function GrantsCard({ tools, tokens }: { tools: McpToolsResponse['tools']; tokens: McpTokenView[] }) {
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
export function ApprovalsCard() {
  const [approvals, setApprovals] = useState<McpApprovalView[]>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string>();

  const load = useCallback(async () => {
    try {
      setApprovals((await api<{ approvals: McpApprovalView[] }>('/api/mcp/approvals', { background: true })).approvals);
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

