'use client';
/**
 * Settings → Governance: which node types (by type, glob or plugin; Code nodes on their own) workflows and agents may
 * use, which hosts the HTTP Request node may call and which MCP servers may be reached; and four-eyes publishing
 * (publish, rollback and unpublish need someone else's approval), with the requests waiting. Saving a workflow that
 * breaks a rule warns, publishing it is refused and its blocked nodes fail at run time. Admins change the policy;
 * everyone sees it.
 */
import { useEffect, useMemo, useState } from 'react';
import { Search, ShieldCheck } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { can } from '@/lib/shared/auth';
import type { AlertsView } from '@/lib/shared/alerts';
import type { GovernancePolicy, ListMode } from '@/lib/shared/governance';
import { useViewer } from '@/components/auth/viewer';
import { PublishRequestCard, usePublishRequests } from '@/components/governance/publish-requests';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, SectionLabel, Select, Switch, Textarea } from '@/components/ui/inputs';

interface GovernanceView {
  policy: GovernancePolicy;
  plugins: { id: string; name: string }[];
  nodeTypes: { type: string; displayName: string; pluginId: string; blocked?: string }[];
}

const lines = (text: string) => [...new Set(text.split(/[\n,]/).map((l) => l.trim()).filter(Boolean))];

function ModePicker<M extends string>({ value, onChange, modes, disabled }: { value: M; onChange: (mode: M) => void; modes: readonly { id: M; label: string }[]; disabled?: boolean }) {
  return (
    <div className="flex gap-0.5 rounded-[10px] border border-hair bg-wl p-0.5" role="radiogroup">
      {modes.map((m) => (
        <button
          key={m.id}
          type="button"
          role="radio"
          aria-checked={value === m.id}
          disabled={disabled}
          onClick={() => onChange(m.id)}
          className={cn('h-7 flex-1 rounded-[8px] text-[12px] transition-colors disabled:cursor-not-allowed', value === m.id ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:text-ac')}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}

const LIST_MODES: readonly { id: ListMode; label: string }[] = [
  { id: 'off', label: 'No rule' },
  { id: 'allow', label: 'Allow only these' },
  { id: 'block', label: 'Block these' },
];

function Toggle({ checked, onChange, disabled, children }: { checked: boolean; onChange: (value: boolean) => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-[13px] text-t1">
      <Switch checked={checked} onChange={onChange} disabled={disabled} label={typeof children === 'string' ? children : undefined} />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function SaveRow({ dirty, saving, onSave, onReset }: { dirty: boolean; saving: boolean; onSave: () => void; onReset: () => void }) {
  if (!dirty) return null;
  return (
    <div className="flex items-center gap-2 border-t border-hair pt-3">
      <Button size="sm" variant="primary" onClick={onSave} loading={saving}>
        Save
      </Button>
      <Button size="sm" variant="ghost" onClick={onReset}>
        Discard changes
      </Button>
    </div>
  );
}

function NodesCard({ view, admin, save }: { view: GovernanceView; admin: boolean; save: (patch: Partial<GovernancePolicy>) => Promise<void> }) {
  const initial = view.policy.nodes;
  const [mode, setMode] = useState(initial.mode);
  const [types, setTypes] = useState(initial.types.join('\n'));
  const [plugins, setPlugins] = useState<string[]>(initial.plugins);
  const [blockCode, setBlockCode] = useState(initial.blockCode);
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);
  const reset = () => {
    setMode(initial.mode);
    setTypes(initial.types.join('\n'));
    setPlugins(initial.plugins);
    setBlockCode(initial.blockCode);
  };
  useEffect(reset, [initial]); // eslint-disable-line react-hooks/exhaustive-deps
  const next = { mode, types: lines(types), plugins, blockCode };
  const dirty = JSON.stringify(next) !== JSON.stringify({ mode: initial.mode, types: initial.types, plugins: initial.plugins, blockCode: initial.blockCode });
  const blocked = view.nodeTypes.filter((t) => t.blocked);
  const shown = view.nodeTypes.filter((t) => query.trim() && `${t.type} ${t.displayName}`.toLowerCase().includes(query.trim().toLowerCase())).slice(0, 12);
  const listed = new Set(lines(types));

  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-[13px] font-semibold text-t1">Nodes</div>
        <p className="text-[12px] text-t3">Node types workflows and agents may use. Blocked nodes are hidden from the node picker, flagged on import and save, refused at publish and fail at run time. A project (its Settings tab) and a workflow (its settings) can narrow this further.</p>
      </div>
      <ModePicker value={mode} onChange={setMode} modes={LIST_MODES} disabled={!admin} />
      {mode !== 'off' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <FieldLabel>Node types</FieldLabel>
            <Textarea rows={6} value={types} onChange={(e) => setTypes(e.target.value)} disabled={!admin} placeholder={'core.httpRequest\nmessaging.*'} className="font-mono text-[12px]" />
            <p className="mt-1 text-[11px] text-t3">One per line; * matches anything (messaging.*).</p>
            {admin && (
              <div className="mt-2 rounded-[10px] border border-hair bg-wl">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
                  <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a node type to add" className="h-8 w-full bg-transparent pl-8 pr-3 text-[12px] text-t1 outline-none placeholder:text-t3" />
                </div>
                {shown.length > 0 && (
                  <div className="max-h-40 overflow-y-auto border-t border-hair py-1">
                    {shown.map((t) => (
                      <button
                        key={t.type}
                        type="button"
                        disabled={listed.has(t.type)}
                        onClick={() => setTypes((current) => [...lines(current), t.type].join('\n'))}
                        className="flex w-full items-center gap-2 px-3 py-1 text-left text-[12px] text-t1 hover:bg-acdim disabled:opacity-50"
                      >
                        <span className="truncate">{t.displayName}</span>
                        <span className="truncate font-mono text-[11px] text-t3">{t.type}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          <div>
            <FieldLabel>Plugins (every node type of the plugin)</FieldLabel>
            <div className="max-h-[180px] overflow-y-auto rounded-[10px] border border-hair bg-wl py-1">
              {view.plugins.map((p) => (
                <label key={p.id} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[12px] text-t1 hover:bg-acdim">
                  <input type="checkbox" disabled={!admin} checked={plugins.includes(p.id)} onChange={(e) => setPlugins((current) => (e.target.checked ? [...current, p.id] : current.filter((id) => id !== p.id)))} />
                  <span className="truncate">{p.name}</span>
                  <span className="truncate font-mono text-[11px] text-t3">{p.id}</span>
                </label>
              ))}
              {!view.plugins.length && <div className="px-3 py-2 text-[12px] text-t3">No plugins registered</div>}
            </div>
          </div>
        </div>
      )}
      <Toggle checked={blockCode} onChange={setBlockCode} disabled={!admin}>
        Block Code nodes <span className="text-[12px] text-t3">(whatever the list says)</span>
      </Toggle>
      {!dirty && (
        <p className="text-[12px] text-t3">
          {blocked.length ? `${blocked.length} of ${view.nodeTypes.length} node types blocked now${blocked.length <= 6 ? `: ${blocked.map((t) => t.displayName).join(', ')}` : ''}.` : 'No node type is blocked.'}
        </p>
      )}
      {admin && (
        <SaveRow
          dirty={dirty}
          saving={saving}
          onReset={reset}
          onSave={async () => {
            setSaving(true);
            await save({ nodes: next });
            setSaving(false);
          }}
        />
      )}
    </Card>
  );
}

function ListCard({
  title,
  hint,
  mode: initialMode,
  items: initialItems,
  modes,
  placeholder,
  itemsHint,
  admin,
  onSave,
}: {
  title: string;
  hint: string;
  mode: ListMode;
  items: string[];
  modes: readonly { id: ListMode; label: string }[];
  placeholder: string;
  itemsHint: React.ReactNode;
  admin: boolean;
  onSave: (mode: ListMode, items: string[]) => Promise<void>;
}) {
  const [mode, setMode] = useState(initialMode);
  const [items, setItems] = useState(initialItems.join('\n'));
  const [saving, setSaving] = useState(false);
  const reset = () => {
    setMode(initialMode);
    setItems(initialItems.join('\n'));
  };
  useEffect(reset, [initialMode, initialItems]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = mode !== initialMode || JSON.stringify(lines(items)) !== JSON.stringify(initialItems);
  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-[13px] font-semibold text-t1">{title}</div>
        <p className="text-[12px] text-t3">{hint}</p>
      </div>
      <ModePicker value={mode} onChange={setMode} modes={modes} disabled={!admin} />
      {mode !== 'off' && (
        <div>
          <Textarea rows={4} value={items} onChange={(e) => setItems(e.target.value)} disabled={!admin} placeholder={placeholder} className="font-mono text-[12px]" />
          <p className="mt-1 text-[11px] text-t3">{itemsHint}</p>
        </div>
      )}
      {admin && (
        <SaveRow
          dirty={dirty}
          saving={saving}
          onReset={reset}
          onSave={async () => {
            setSaving(true);
            await onSave(mode, lines(items));
            setSaving(false);
          }}
        />
      )}
    </Card>
  );
}

function FourEyesCard({ view, admin, save }: { view: GovernanceView; admin: boolean; save: (patch: Partial<GovernancePolicy>) => Promise<void> }) {
  const initial = view.policy.fourEyes;
  const [draft, setDraft] = useState(initial);
  const [channels, setChannels] = useState<AlertsView['channels']>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => setDraft(initial), [initial]);
  useEffect(() => {
    api<AlertsView>('/api/settings/alerts').then(
      (alerts) => setChannels(alerts.channels),
      () => undefined,
    );
  }, []);
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial);

  return (
    <Card className="space-y-3 p-4">
      <div>
        <div className="text-[13px] font-semibold text-t1">Four-eyes publishing</div>
        <p className="text-[12px] text-t3">
          Publishing, rolling back and unpublishing need a second person: Publish asks for approval instead, and someone else approves or rejects it. A request goes stale when the draft or
          the live version changes before it is decided. Nobody can approve their own request.
        </p>
      </div>
      <Toggle checked={draft.enabled} onChange={(value) => set({ enabled: value })} disabled={!admin}>
        Require approval to publish
      </Toggle>
      {draft.enabled && (
        <div className="space-y-3 pl-11">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:items-center">
            <FieldLabel className="mb-0">Who may approve</FieldLabel>
            <Select value={draft.approverRole} onChange={(e) => set({ approverRole: e.target.value as typeof draft.approverRole })} disabled={!admin} className="max-w-[320px]">
              <option value="member">Any other builder (member, admin, owner)</option>
              <option value="admin">Owners and admins only</option>
            </Select>
          </div>
          <Toggle checked={draft.unpublish} onChange={(value) => set({ unpublish: value })} disabled={!admin}>
            Unpublishing needs approval too
          </Toggle>
          <Toggle checked={draft.notifyEmail} onChange={(value) => set({ notifyEmail: value })} disabled={!admin}>
            Email approvers about new requests, and the requester when one is decided
          </Toggle>
          <div>
            <FieldLabel>Also tell these alert channels</FieldLabel>
            {channels.length ? (
              <div className="flex flex-wrap gap-1.5">
                {channels.map((c) => {
                  const on = draft.channelIds.includes(c.id);
                  return (
                    <button
                      key={c.id}
                      type="button"
                      disabled={!admin}
                      aria-pressed={on}
                      onClick={() => set({ channelIds: on ? draft.channelIds.filter((id) => id !== c.id) : [...draft.channelIds, c.id] })}
                      className={cn('h-7 rounded-full border px-3 text-[12px] transition-colors', on ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
                    >
                      {c.name}
                    </button>
                  );
                })}
              </div>
            ) : (
              <p className="text-[12px] text-t3">No alert channels yet (Settings → Alerts).</p>
            )}
          </div>
        </div>
      )}
      {admin && (
        <SaveRow
          dirty={dirty}
          saving={saving}
          onReset={() => setDraft(initial)}
          onSave={async () => {
            setSaving(true);
            await save({ fourEyes: draft });
            setSaving(false);
          }}
        />
      )}
    </Card>
  );
}

function Requests() {
  const [all, setAll] = useState(false);
  const { list, reload } = usePublishRequests({ status: all ? 'all' : undefined });
  if (!list || (!list.fourEyes.enabled && !list.requests.length)) return null;
  return (
    <section className="space-y-2.5">
      <div className="flex items-center gap-3">
        <SectionLabel className="flex-1">
          Publish requests {list.approvable > 0 && <Badge tone="warning">{list.approvable} for you</Badge>}
        </SectionLabel>
        <Button size="sm" variant="ghost" onClick={() => setAll((a) => !a)}>
          {all ? 'Pending only' : 'Show decided too'}
        </Button>
      </div>
      <Card className="overflow-hidden p-0">
        {list.requests.map((request) => (
          <PublishRequestCard key={request.id} request={request} onChanged={() => void reload()} showWorkflow className="border-b border-hair last:border-b-0" />
        ))}
        {!list.requests.length && (
          <div className="py-6">
            <EmptyState title={all ? 'No publish requests yet' : 'Nothing waiting for approval'} />
          </div>
        )}
      </Card>
    </section>
  );
}

export function GovernanceSettings() {
  const viewer = useViewer();
  const admin = can(viewer, 'settings:manage');
  const [view, setView] = useState<GovernanceView>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    api<GovernanceView>('/api/settings/governance').then(setView, (e: Error) => setError(e.message));
  }, []);

  const save = async (patch: Partial<GovernancePolicy>) => {
    try {
      setView(await api<GovernanceView>('/api/settings/governance', { method: 'PATCH', json: patch }));
      toast.success('Policy saved');
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const updated = useMemo(() => view?.policy.updatedAt && `Last changed ${timeAgo(view.policy.updatedAt)}`, [view?.policy.updatedAt]);

  if (error) return <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;
  if (!view) return <div className="text-[13px] text-t3">Loading…</div>;

  return (
    <div className="space-y-6">
      <p className="flex items-start gap-2 text-[13px] text-t2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-t3" />
        <span>
          Instance-wide rules for what workflows may do and who may put them live. Rules apply to every workflow, trigger and agent run, on this host and its workers. With every rule off,
          nothing changes. {updated}
          {!admin && ' Only admins can change the policy.'}
        </span>
      </p>

      <section className="space-y-2.5">
        <SectionLabel>Allowlist</SectionLabel>
        <NodesCard view={view} admin={admin} save={save} />
        <ListCard
          title="HTTP Request hosts"
          hint="Hosts the HTTP Request node may call, checked per item at run time."
          mode={view.policy.http.mode}
          items={view.policy.http.hosts}
          modes={LIST_MODES}
          placeholder={'api.example.com\n*.internal.example.com\n10.0.0.0/8\n2001:db8::/32'}
          itemsHint="One per line: a host name (* matches anything), host:port, an IPv4 or IPv6 address, or a CIDR range (10.0.0.0/8, fd00::/8; [::1]:8080 with a port)."
          admin={admin}
          onSave={(mode, hosts) => save({ http: { mode, hosts } })}
        />
        <ListCard
          title="MCP servers"
          hint="Servers the MCP Client node and tool, and AI agents, may connect to."
          mode={view.policy.mcp.mode}
          items={view.policy.mcp.urls}
          modes={LIST_MODES.filter((m) => m.id !== 'block')}
          placeholder={'https://mcp.example.com/*\nmcp.internal'}
          itemsHint="One per line: a URL pattern (* matches anything) or a host name."
          admin={admin}
          onSave={(mode, urls) => save({ mcp: { mode: mode as 'off' | 'allow', urls } })}
        />
      </section>

      <section className="space-y-2.5">
        <SectionLabel>Publishing</SectionLabel>
        <FourEyesCard view={view} admin={admin} save={save} />
      </section>

      <Requests />
    </div>
  );
}
