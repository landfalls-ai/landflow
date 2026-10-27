'use client';
/**
 * Settings → AI prices → AI usage caps: limits per model credential and per user (who started the run), per day or month,
 * in tokens or US dollars. A call over a cap stops with a clear error, like the caps in workflow and agent settings; an
 * alert rule of kind “AI cost” (Settings → Alerts) warns before one is reached. A user’s cap counts the runs that user
 * started (the editor’s Execute, the API, chat); runs started by a schedule or webhook have no user.
 */
import { useEffect, useMemo, useState } from 'react';
import { Gauge, Plus, Save, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/client/api';
import { can } from '@/lib/shared/auth';
import type { UserView } from '@/lib/shared/auth';
import { formatCost, formatTokens, type AiCaps, type AiCapsView, type AiUsageTotals, type UsageCapSet } from '@/lib/shared/ai-usage';
import { useViewer } from '@/components/auth/viewer';
import { useCredentials } from '@/components/credentials/use-credentials';
import { Card } from '@/components/shell/page-header';
import { Button } from '@/components/ui/button';
import { Input, SectionLabel, Select } from '@/components/ui/inputs';

/** Credential types that call models. */
const MODEL_CREDENTIALS = new Set(['core.anthropicApi', 'core.openAiApi']);

type Limits = Pick<UsageCapSet, 'dayTokens' | 'dayCost' | 'monthTokens' | 'monthCost'>;
const FIELDS = [
  { key: 'dayTokens', label: 'Tokens / day' },
  { key: 'dayCost', label: '$ / day' },
  { key: 'monthTokens', label: 'Tokens / month' },
  { key: 'monthCost', label: '$ / month' },
] as const;

/** A set as typed (numbers kept as text until saved). */
type Draft = Record<(typeof FIELDS)[number]['key'], string>;
const toDraft = (set?: UsageCapSet): Draft => Object.fromEntries(FIELDS.map(({ key }) => [key, set?.[key] ? String(set[key]) : ''])) as Draft;

function toSet(draft: Draft, name?: string): { set: UsageCapSet } | { error: string } {
  const set: UsageCapSet = { ...(name && { name }) };
  for (const { key, label } of FIELDS) {
    const text = draft[key].trim().replace(/[,_ ]/g, '');
    if (!text) continue;
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) return { error: `${label}: enter a number, 0 or more (empty = no cap)` };
    if (value > 0) set[key] = value;
  }
  return { set };
}

interface Row {
  key: string;
  kind: 'credential' | 'user';
  id: string;
  draft: Draft;
}

const usageText = (totals?: AiUsageTotals) => (totals?.calls ? `${formatTokens(totals.inputTokens + totals.outputTokens)} tokens · ${formatCost(totals.cost)}` : 'nothing yet');

export function AiCapsSettings() {
  const viewer = useViewer();
  const admin = can(viewer, 'settings:manage');
  const { credentials } = useCredentials();
  const [view, setView] = useState<AiCapsView>();
  const [users, setUsers] = useState<UserView[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [everyone, setEveryone] = useState<Draft>(toDraft());
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);

  const apply = (next: AiCapsView) => {
    setView(next);
    setRows([
      ...Object.entries(next.caps.credentials).map(([id, set]): Row => ({ key: `credential:${id}`, kind: 'credential', id, draft: toDraft(set) })),
      ...Object.entries(next.caps.users).map(([id, set]): Row => ({ key: `user:${id}`, kind: 'user', id, draft: toDraft(set) })),
    ]);
    setEveryone(toDraft(next.caps.allUsers));
  };
  useEffect(() => {
    api<AiCapsView>('/api/settings/ai-caps')
      .then(apply)
      .catch((e: Error) => setError(e.message));
    api<{ users: UserView[] }>('/api/users')
      .then((result) => setUsers(result.users))
      .catch(() => setUsers([]));
  }, []);

  const modelCredentials = useMemo(() => (credentials ?? []).filter((credential) => MODEL_CREDENTIALS.has(credential.type)), [credentials]);
  const nameOf = (row: Row) => (row.kind === 'credential' ? (credentials?.find((c) => c.id === row.id)?.name ?? view?.caps.credentials[row.id]?.name ?? row.id) : (users.find((u) => u.id === row.id)?.name || users.find((u) => u.id === row.id)?.email || view?.caps.users[row.id]?.name || row.id));
  const taken = new Set(rows.map((row) => row.key));
  const set = (key: string, patch: Partial<Draft>) => setRows((list) => list.map((row) => (row.key === key ? { ...row, draft: { ...row.draft, ...patch } } : row)));

  const built = useMemo((): { caps: AiCaps } | { error: string } => {
    const caps: AiCaps = { credentials: {}, users: {} };
    for (const row of rows) {
      const parsed = toSet(row.draft);
      if ('error' in parsed) return { error: `${row.kind === 'credential' ? 'Credential' : 'User'} “${nameOf(row)}”: ${parsed.error}` };
      (row.kind === 'credential' ? caps.credentials : caps.users)[row.id] = parsed.set;
    }
    const all = toSet(everyone);
    if ('error' in all) return { error: `Every user: ${all.error}` };
    if (Object.keys(all.set).length) caps.allUsers = all.set;
    return { caps };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, everyone, credentials, users]);

  const dirty = Boolean(view && 'caps' in built && JSON.stringify(strip(built.caps)) !== JSON.stringify(strip(view.caps)));

  const save = async () => {
    if (!('caps' in built)) return setError(built.error);
    setSaving(true);
    setError(undefined);
    try {
      apply(await api<AiCapsView>('/api/settings/ai-caps', { method: 'PUT', json: built.caps }));
      toast.success('AI usage caps saved');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  if (!view) {
    return error ? <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div> : <div className="h-32 rounded-2xl border border-hair bg-sf animate-pulse-soft" />;
  }

  const cell = 'h-8 w-28 px-2 text-right font-mono text-[12px]';
  const usageOf = (row: Row) => (row.kind === 'credential' ? view.usage.credentials[row.id] : view.usage.users[row.id]);
  return (
    <Card className="px-5 py-4">
      <div className="mb-1 flex items-center gap-2">
        <Gauge className="size-4 text-t3" strokeWidth={1.8} />
        <SectionLabel>AI usage caps</SectionLabel>
      </div>
      <p className="mb-3 text-[12px] leading-relaxed text-t3">
        Limits per model credential (every call made with it, by any workflow or agent) and per user (the runs that user started: Execute in the editor, the API, chat). Per day or month, in tokens or
        dollars; empty means no cap. A call over a cap stops with a clear error, like the limits in workflow and agent settings. Add an <span className="font-semibold text-t2">AI cost</span> rule in
        Settings → Alerts to be warned at 80% of a cap.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[820px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-[12px] text-t2">
              <th className="pb-1.5 pr-2 font-semibold">Applies to</th>
              {FIELDS.map(({ key, label }) => (
                <th key={key} className="pb-1.5 pr-2 text-right font-semibold">
                  {label}
                </th>
              ))}
              <th className="pb-1.5 pr-2 font-semibold">Used today · this month</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const used = usageOf(row);
              return (
                <tr key={row.key}>
                  <td className="py-1 pr-2">
                    <div className="text-t1">{nameOf(row)}</div>
                    <div className="text-[11px] text-t3">{row.kind === 'credential' ? 'Credential' : 'User'}</div>
                  </td>
                  {FIELDS.map(({ key, label }) => (
                    <td key={key} className="py-1 pr-2">
                      <Input value={row.draft[key]} onChange={(e) => set(row.key, { [key]: e.target.value })} disabled={!admin} inputMode="decimal" aria-label={`${nameOf(row)} ${label}`} className={cell} />
                    </td>
                  ))}
                  <td className="py-1 pr-2 text-[12px] text-t3">
                    {usageText(used?.day)} · {usageText(used?.month)}
                  </td>
                  <td className="py-1">
                    {admin && (
                      <Button size="icon-sm" variant="ghost" aria-label={`Remove the cap of ${nameOf(row)}`} title="Remove" className="hover:bg-rddim hover:text-rd" onClick={() => setRows((list) => list.filter((r) => r.key !== row.key))}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr>
              <td className="py-1 pr-2">
                <div className="text-t1">Every user</div>
                <div className="text-[11px] text-t3">Users without a cap of their own</div>
              </td>
              {FIELDS.map(({ key, label }) => (
                <td key={key} className="py-1 pr-2">
                  <Input value={everyone[key]} onChange={(e) => setEveryone({ ...everyone, [key]: e.target.value })} disabled={!admin} inputMode="decimal" aria-label={`Every user ${label}`} className={cell} />
                </td>
              ))}
              <td colSpan={2} />
            </tr>
          </tbody>
        </table>
      </div>
      {admin && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Plus className="size-3.5 text-t3" />
          <Select
            value=""
            onChange={(e) => e.target.value && setRows((list) => [...list, { key: `credential:${e.target.value}`, kind: 'credential', id: e.target.value, draft: toDraft() }])}
            aria-label="Add a credential cap"
            className="h-8 w-56 text-[12px]"
          >
            <option value="">Cap a credential…</option>
            {modelCredentials
              .filter((credential) => !taken.has(`credential:${credential.id}`))
              .map((credential) => (
                <option key={credential.id} value={credential.id}>
                  {credential.name}
                </option>
              ))}
          </Select>
          <Select
            value=""
            onChange={(e) => e.target.value && setRows((list) => [...list, { key: `user:${e.target.value}`, kind: 'user', id: e.target.value, draft: toDraft() }])}
            aria-label="Add a user cap"
            className="h-8 w-56 text-[12px]"
          >
            <option value="">Cap a user…</option>
            {users
              .filter((user) => !taken.has(`user:${user.id}`))
              .map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name || user.email}
                </option>
              ))}
          </Select>
        </div>
      )}
      {error && <div className="mt-3 rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd animate-fade-up">{error}</div>}
      {admin ? (
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-hair pt-3.5">
          {'error' in built && <span className="mr-auto text-[12px] text-warn">{built.error}</span>}
          {dirty && (
            <Button variant="ghost" onClick={() => apply(view)}>
              Discard
            </Button>
          )}
          <Button variant="primary" onClick={save} loading={saving} disabled={!dirty}>
            <Save className="size-3.5" /> Save
          </Button>
        </div>
      ) : (
        <p className="mt-3 text-[12px] text-t3">Only owners and admins can change caps.</p>
      )}
    </Card>
  );
}

/** Caps without names, for comparing what is typed with what is saved. */
function strip(caps: AiCaps) {
  const clean = (record: Record<string, UsageCapSet>) => Object.fromEntries(Object.entries(record).map(([id, { name: _name, ...limits }]) => [id, limits as Limits]));
  return { credentials: clean(caps.credentials), users: clean(caps.users), allUsers: caps.allUsers ? (({ name: _name, ...limits }) => limits)(caps.allUsers) : undefined };
}
