'use client';
/**
 * Settings → Alerts: failure alerts without an error workflow. Channels say where an alert goes (email over the
 * host's SMTP settings, a Slack incoming webhook, a signed webhook, a Telegram chat) and can send a test; rules say
 * which runs alert (all workflows, some, or by tag; failed, timed out, retries exhausted, waiting too long) and how
 * often (one alert per workflow per window, the rest as a digest). Admins change them; everyone else sees them.
 */
import { useEffect, useMemo, useState } from 'react';
import { BellRing, Check, Mail, MessageCircle, MessageSquare, Pencil, Plus, Search, Send, Trash2, TriangleAlert, Users, Webhook, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import { can } from '@/lib/shared/auth';
import {
  ALERT_CHANNEL_KINDS,
  ALERT_EVENTS,
  ALERT_RULE_KINDS,
  DEFAULT_COST_THRESHOLD_PERCENT,
  DEFAULT_FAILURE_RATE,
  DEFAULT_PLUGIN_GRACE_SECONDS,
  DEFAULT_THROTTLE_MINUTES,
  DEFAULT_WAITING_MINUTES,
  type AlertChannel,
  type AlertChannelConfig,
  type AlertChannelKind,
  type AlertDelivery,
  type AlertEvent,
  type AlertRule,
  type AlertRuleKind,
  type AlertScope,
  type AlertsView,
} from '@/lib/shared/alerts';
import type { PluginSummary, WorkflowSummary } from '@/lib/shared/types';
import { useViewer } from '@/components/auth/viewer';
import { useCredentials } from '@/components/credentials/use-credentials';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FieldLabel, Input, SectionLabel, Select, Switch } from '@/components/ui/inputs';

const KIND_ICON: Record<AlertChannelKind, typeof Mail> = { email: Mail, slack: MessageSquare, webhook: Webhook, telegram: Send, teams: Users, discord: MessageCircle };
const THROTTLES = [
  { value: 0, label: 'Every alert' },
  { value: 5, label: 'At most one per 5 min' },
  { value: 10, label: 'At most one per 10 min' },
  { value: 30, label: 'At most one per 30 min' },
  { value: 60, label: 'At most one per hour' },
  { value: 240, label: 'At most one per 4 hours' },
  { value: 1440, label: 'At most one per day' },
];
const EVENT_LABEL = Object.fromEntries(ALERT_EVENTS.map((e) => [e.id, e.label])) as Record<AlertEvent, string>;

/** "Ops team · email" one-liner of what a channel sends to. */
function channelTarget(channel: AlertChannel, telegramName?: string): string {
  switch (channel.kind) {
    case 'email':
      return channel.config.to ?? '';
    case 'slack':
    case 'teams':
    case 'discord':
      return channel.secretsSet.includes('webhookUrl') ? 'Incoming webhook (saved)' : 'No webhook URL';
    case 'webhook':
      return `${channel.config.url ?? ''}${channel.secretsSet.includes('secret') ? ' · signed' : ''}`;
    case 'telegram':
      return `Chat ${channel.config.chatId ?? '?'}${telegramName ? ` via ${telegramName}` : ''}`;
  }
}

function DeliveryLine({ delivery }: { delivery?: AlertDelivery }) {
  if (!delivery) return <span className="text-t3">Nothing sent yet</span>;
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1', delivery.ok ? 'text-gn' : 'text-rd')} title={delivery.message}>
      {delivery.ok ? <Check className="size-3 shrink-0" /> : <TriangleAlert className="size-3 shrink-0" />}
      <span className="truncate">
        {delivery.ok ? 'Sent' : 'Failed'} {timeAgo(delivery.at)}
        {!delivery.ok && delivery.message ? ` — ${delivery.message}` : ''}
      </span>
    </span>
  );
}

function ChannelEditor({
  initial,
  emailConfigured,
  onSaved,
  onCancel,
}: {
  initial?: AlertChannel;
  emailConfigured: boolean;
  onSaved: (view: AlertsView) => void;
  onCancel: () => void;
}) {
  const { credentials } = useCredentials();
  const [kind, setKind] = useState<AlertChannelKind>(initial?.kind ?? 'email');
  const [name, setName] = useState(initial?.name ?? '');
  const [config, setConfig] = useState<AlertChannelConfig>(initial?.config ?? {});
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const telegram = (credentials ?? []).filter((c) => c.type === 'messaging.telegramApi');
  const set = (next: Partial<AlertChannelConfig>) => setConfig((c) => ({ ...c, ...next }));
  const saved = (field: string) => Boolean(initial?.secretsSet.includes(field));

  const save = async () => {
    setSaving(true);
    setProblem(undefined);
    try {
      const view = initial
        ? await api<AlertsView>(`/api/settings/alerts/channels/${initial.id}`, { method: 'PATCH', json: { name, config } })
        : await api<AlertsView>('/api/settings/alerts/channels', { method: 'POST', json: { name: name || ALERT_CHANNEL_KINDS.find((k) => k.id === kind)!.label, kind, config } });
      toast.success(initial ? `Saved ${name}` : 'Channel added — send a test to check it');
      onSaved(view);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 border-b border-hair bg-sf2 px-4 py-3.5 last:border-b-0 animate-fade-up">
      {!initial && (
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Channel type">
          {ALERT_CHANNEL_KINDS.map((k) => {
            const Icon = KIND_ICON[k.id];
            return (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={kind === k.id}
                title={k.hint}
                onClick={() => setKind(k.id)}
                className={cn('flex h-8 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors', kind === k.id ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
              >
                <Icon className="size-3.5" /> {k.label}
              </button>
            );
          })}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
        <div>
          <FieldLabel>Name</FieldLabel>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={kind === 'email' ? 'Ops team' : kind === 'slack' ? '#alerts' : kind === 'telegram' ? 'On-call chat' : kind === 'teams' ? 'Ops channel' : kind === 'discord' ? '#incidents' : 'Incident tool'} autoFocus />
        </div>
        {kind === 'email' && (
          <div>
            <FieldLabel>Send to</FieldLabel>
            <Input value={config.to ?? ''} onChange={(e) => set({ to: e.target.value })} placeholder="ops@example.com, Jane <jane@example.com>" />
          </div>
        )}
        {(kind === 'slack' || kind === 'teams' || kind === 'discord') && (
          <div>
            <FieldLabel>{kind === 'slack' ? 'Incoming webhook URL' : kind === 'teams' ? 'Webhook URL (Workflows or incoming webhook)' : 'Webhook URL'}</FieldLabel>
            <Input
              type="password"
              autoComplete="off"
              value={config.webhookUrl ?? ''}
              onChange={(e) => set({ webhookUrl: e.target.value })}
              placeholder={
                saved('webhookUrl')
                  ? 'Saved — leave empty to keep it'
                  : kind === 'slack'
                    ? 'https://hooks.slack.com/services/…'
                    : kind === 'teams'
                      ? 'https://prod-00.westeurope.logic.azure.com/workflows/…'
                      : 'https://discord.com/api/webhooks/…'
              }
            />
          </div>
        )}
        {kind === 'webhook' && (
          <div>
            <FieldLabel>URL</FieldLabel>
            <Input value={config.url ?? ''} onChange={(e) => set({ url: e.target.value })} placeholder="https://example.com/landflow-alerts" />
          </div>
        )}
        {kind === 'telegram' && (
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,160px)] gap-3">
            <div>
              <FieldLabel>Telegram credential</FieldLabel>
              <Select value={config.credentialId ?? ''} onChange={(e) => set({ credentialId: e.target.value })}>
                <option value="">{telegram.length ? 'Choose a bot' : 'No Telegram API credential yet'}</option>
                {telegram.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <FieldLabel>Chat ID</FieldLabel>
              <Input value={config.chatId ?? ''} onChange={(e) => set({ chatId: e.target.value })} placeholder="-1001234567890" />
            </div>
          </div>
        )}
      </div>
      {kind === 'webhook' && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,200px)_minmax(0,1fr)]">
          <div className="hidden sm:block" />
          <div>
            <FieldLabel>Signing secret (optional)</FieldLabel>
            <Input type="password" autoComplete="off" value={config.secret ?? ''} onChange={(e) => set({ secret: e.target.value })} placeholder={saved('secret') ? 'Saved — leave empty to keep it' : 'Any long random string'} />
            <p className="mt-1 text-[11px] leading-snug text-t3">
              Each POST carries <code className="font-mono">X-Landflow-Timestamp</code> and <code className="font-mono">X-Landflow-Signature: sha256=…</code>, the HMAC-SHA256 of{' '}
              <code className="font-mono">{'<timestamp>.<body>'}</code> with this secret.
            </p>
          </div>
        </div>
      )}
      {kind === 'email' && !emailConfigured && (
        <p className="flex items-start gap-1.5 text-[12px] text-warn">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Email isn’t set up on this host: set <code className="font-mono">LANDFLOW_SMTP_HOST</code> (and <code className="font-mono">_PORT</code>, <code className="font-mono">_USER</code>,{' '}
            <code className="font-mono">_PASS</code>, <code className="font-mono">_FROM</code>) and restart. Until then this channel’s alerts fail.
          </span>
        </p>
      )}
      {kind === 'slack' && <p className="text-[12px] text-t3">In Slack: create an app → Incoming Webhooks → Add New Webhook to Workspace, pick the channel, copy the URL.</p>}
      {kind === 'teams' && (
        <p className="text-[12px] text-t3">
          In Teams: the channel’s ⋯ menu → Workflows → “Post to a channel when a webhook request is received”, then copy the URL. Alerts arrive as an Adaptive Card. The older incoming-webhook connectors work too.
        </p>
      )}
      {kind === 'discord' && <p className="text-[12px] text-t3">In Discord: Channel settings → Integrations → Webhooks → New Webhook → Copy Webhook URL. Alerts arrive as an embed.</p>}
      {problem && <div className="text-[12px] text-rd">{problem}</div>}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
          {initial ? 'Save channel' : 'Add channel'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ScopeEditor({ scope, onChange, workflows }: { scope: AlertScope; onChange: (scope: AlertScope) => void; workflows: WorkflowSummary[] }) {
  const [query, setQuery] = useState('');
  const [tagText, setTagText] = useState((scope.tags ?? []).join(', '));
  const ids = new Set(scope.ids ?? []);
  const allTags = useMemo(() => [...new Set(workflows.flatMap((w) => w.tags))].sort(), [workflows]);
  const shown = workflows.filter((w) => !query.trim() || w.name.toLowerCase().includes(query.trim().toLowerCase()));
  const modes = [
    { id: 'all', label: 'All workflows' },
    { id: 'ids', label: 'Selected workflows' },
    { id: 'tags', label: 'By tag' },
  ] as const;
  return (
    <div className="space-y-2">
      <div className="flex gap-0.5 rounded-[10px] border border-hair bg-wl p-0.5" role="radiogroup" aria-label="Workflows">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={scope.mode === m.id}
            onClick={() => onChange({ ...scope, mode: m.id })}
            className={cn('h-7 flex-1 rounded-[8px] text-[12px] transition-colors', scope.mode === m.id ? 'bg-acdim font-semibold text-t1' : 'text-t2 hover:text-ac')}
          >
            {m.label}
          </button>
        ))}
      </div>
      {scope.mode === 'ids' && (
        <div className="rounded-[10px] border border-hair bg-wl">
          <div className="relative border-b border-hair">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-t3" />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search workflows" className="h-8 w-full bg-transparent pl-8 pr-3 text-[12px] text-t1 outline-none placeholder:text-t3" />
          </div>
          <div className="max-h-44 overflow-y-auto py-1">
            {shown.map((w) => (
              <label key={w.id} className="flex cursor-pointer items-center gap-2 px-3 py-1 text-[12px] text-t1 hover:bg-acdim">
                <input
                  type="checkbox"
                  checked={ids.has(w.id)}
                  onChange={(e) => {
                    const next = new Set(ids);
                    if (e.target.checked) next.add(w.id);
                    else next.delete(w.id);
                    onChange({ ...scope, ids: [...next] });
                  }}
                />
                <span className="truncate">{w.name}</span>
                {!w.active && <span className="text-[11px] text-t3">inactive</span>}
              </label>
            ))}
            {!shown.length && <div className="px-3 py-2 text-[12px] text-t3">No workflow matches</div>}
          </div>
        </div>
      )}
      {scope.mode === 'tags' && (
        <div>
          <Input
            value={tagText}
            onChange={(e) => {
              setTagText(e.target.value);
              onChange({ ...scope, tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) });
            }}
            placeholder="production, billing"
          />
          {allTags.length > 0 && <p className="mt-1 text-[11px] text-t3">Tags in use: {allTags.join(', ')}</p>}
        </div>
      )}
    </div>
  );
}

type RuleDraft = Omit<AlertRule, 'id' | 'createdAt' | 'updatedAt'>;

function RuleEditor({
  initial,
  channels,
  workflows,
  onSaved,
  onCancel,
}: {
  initial?: AlertRule;
  channels: AlertChannel[];
  workflows: WorkflowSummary[];
  onSaved: (view: AlertsView) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<RuleDraft>(
    () =>
      initial ?? {
        kind: 'runs',
        name: '',
        enabled: true,
        workflows: { mode: 'all' },
        events: ['failed'],
        channelIds: channels.length === 1 ? [channels[0].id] : [],
        throttleMinutes: DEFAULT_THROTTLE_MINUTES,
      },
  );
  const [waiting, setWaiting] = useState(String(initial?.waitingMinutes ?? DEFAULT_WAITING_MINUTES));
  const [rate, setRate] = useState({
    minRuns: String(initial?.failureRate?.minRuns ?? DEFAULT_FAILURE_RATE.minRuns),
    percent: String(initial?.failureRate?.percent ?? DEFAULT_FAILURE_RATE.percent),
    windowMinutes: String(initial?.failureRate?.windowMinutes ?? DEFAULT_FAILURE_RATE.windowMinutes),
  });
  const [pluginIds, setPluginIds] = useState<string[]>(initial?.plugins?.ids ?? []);
  const [grace, setGrace] = useState(String(initial?.plugins?.graceSeconds ?? DEFAULT_PLUGIN_GRACE_SECONDS));
  const [recovery, setRecovery] = useState(initial?.plugins?.notifyRecovery ?? true);
  const [threshold, setThreshold] = useState(String(initial?.cost?.thresholdPercent ?? DEFAULT_COST_THRESHOLD_PERCENT));
  const [score, setScore] = useState({ metric: initial?.evaluation?.metric ?? '', below: initial?.evaluation?.below === undefined ? '' : String(initial.evaluation.below), dropPercent: initial?.evaluation?.dropPercent === undefined ? '' : String(initial.evaluation.dropPercent) });
  const [plugins, setPlugins] = useState<PluginSummary[]>([]);
  const [saving, setSaving] = useState(false);
  const kind: AlertRuleKind = draft.kind ?? 'runs';
  useEffect(() => {
    if (kind !== 'plugin') return;
    api<{ plugins: PluginSummary[] }>('/api/plugins')
      .then((result) => setPlugins(result.plugins.filter((plugin) => plugin.transport !== 'in-process')))
      .catch(() => setPlugins([]));
  }, [kind]);
  const [problem, setProblem] = useState<string>();
  const patch = (next: Partial<RuleDraft>) => setDraft((d) => ({ ...d, ...next }));
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  const save = async () => {
    setProblem(undefined);
    if (kind === 'runs' && !draft.events.length) return setProblem('Pick at least one event');
    if (!draft.channelIds.length) return setProblem('Pick at least one channel');
    const scoped = kind === 'runs' || kind === 'failureRate' || kind === 'evaluation';
    if (scoped && draft.workflows.mode === 'ids' && !draft.workflows.ids?.length) return setProblem('Pick at least one workflow');
    if (scoped && draft.workflows.mode === 'tags' && !draft.workflows.tags?.length) return setProblem('Enter at least one tag');
    const minutes = Number(waiting);
    if (kind === 'runs' && draft.events.includes('waiting') && !(Number.isInteger(minutes) && minutes >= 1)) return setProblem('Waiting minutes must be a whole number of at least 1');
    const { shortcutFor: _shortcut, failureRate: _rate, plugins: _plugins, cost: _cost, evaluation: _evaluation, ...fields } = draft;
    const body: Record<string, unknown> = {
      ...fields,
      kind,
      name: draft.name.trim() || ALERT_RULE_KINDS.find((k) => k.id === kind)?.label || 'Alert',
      ...(kind === 'runs' && draft.events.includes('waiting') ? { waitingMinutes: minutes } : {}),
      includeManual: Boolean(draft.includeManual),
    };
    if (kind === 'failureRate') {
      const limits = { minRuns: Number(rate.minRuns), percent: Number(rate.percent), windowMinutes: Number(rate.windowMinutes) };
      if (!(Number.isInteger(limits.minRuns) && limits.minRuns >= 1)) return setProblem('Minimum runs must be a whole number of at least 1');
      if (!(limits.percent >= 0 && limits.percent <= 100)) return setProblem('The failure rate is a percentage from 0 to 100');
      if (!(Number.isInteger(limits.windowMinutes) && limits.windowMinutes >= 1 && limits.windowMinutes <= 1_440)) return setProblem('The window is 1 to 1,440 minutes');
      body.failureRate = limits;
    } else if (kind === 'plugin') {
      const seconds = Number(grace);
      if (!(Number.isInteger(seconds) && seconds >= 0)) return setProblem('The grace period is a whole number of seconds');
      body.plugins = { ...(pluginIds.length && { ids: pluginIds }), graceSeconds: seconds, notifyRecovery: recovery };
    } else if (kind === 'cost') {
      const percent = Number(threshold);
      if (!(percent >= 1 && percent <= 100)) return setProblem('The threshold is a percentage from 1 to 100');
      body.cost = { thresholdPercent: percent };
    } else if (kind === 'evaluation') {
      const below = score.below.trim() === '' ? undefined : Number(score.below);
      const drop = score.dropPercent.trim() === '' ? undefined : Number(score.dropPercent);
      if ((below !== undefined && !Number.isFinite(below)) || (drop !== undefined && !(drop > 0 && drop <= 100))) return setProblem('Enter a minimum score and/or a drop between 0 and 100 percent');
      if (below === undefined && drop === undefined) return setProblem('Set a minimum score, a drop in percent, or both');
      body.evaluation = { ...(score.metric.trim() && { metric: score.metric.trim() }), ...(below !== undefined && { below }), ...(drop !== undefined && { dropPercent: drop }) };
    }
    setSaving(true);
    try {
      const view = initial
        ? await api<AlertsView>(`/api/settings/alerts/rules/${initial.id}`, { method: 'PATCH', json: body })
        : await api<AlertsView>('/api/settings/alerts/rules', { method: 'POST', json: body });
      toast.success(initial ? `Saved ${body.name}` : `Added ${body.name}`);
      onSaved(view);
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3.5 border-b border-hair bg-sf2 px-4 py-3.5 last:border-b-0 animate-fade-up">
      <div>
        <FieldLabel>Alert on</FieldLabel>
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Rule type">
          {ALERT_RULE_KINDS.map((k) => (
            <button
              key={k.id}
              type="button"
              role="radio"
              aria-checked={kind === k.id}
              title={k.hint}
              onClick={() => patch({ kind: k.id })}
              className={cn('h-7 rounded-full border px-3 text-[12px] transition-colors', kind === k.id ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
            >
              {k.label}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-[11px] text-t3">{ALERT_RULE_KINDS.find((k) => k.id === kind)?.hint}.</p>
      </div>
      <div>
        <FieldLabel>Name</FieldLabel>
        <Input value={draft.name} onChange={(e) => patch({ name: e.target.value })} placeholder={ALERT_RULE_KINDS.find((k) => k.id === kind)?.label} autoFocus />
      </div>
      {(kind === 'runs' || kind === 'failureRate' || kind === 'evaluation') && (
        <div>
          <FieldLabel>Workflows</FieldLabel>
          <ScopeEditor scope={draft.workflows} onChange={(workflows) => patch({ workflows })} workflows={workflows} />
        </div>
      )}
      {kind === 'failureRate' && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-t2">
            Alert when at least
            <Input value={rate.minRuns} onChange={(e) => setRate({ ...rate, minRuns: e.target.value })} inputMode="numeric" className="h-7 w-16 text-center" aria-label="Minimum runs" />
            runs started in the last
            <Input value={rate.windowMinutes} onChange={(e) => setRate({ ...rate, windowMinutes: e.target.value })} inputMode="numeric" className="h-7 w-20 text-center" aria-label="Window in minutes" />
            minutes and more than
            <Input value={rate.percent} onChange={(e) => setRate({ ...rate, percent: e.target.value })} inputMode="decimal" className="h-7 w-16 text-center" aria-label="Failure percent" />% of them failed
          </div>
          <p className="text-[11px] text-t3">Counted per workflow over production runs (editor, debug and evaluation runs and runs with a retry still to come are left out). One alert per workflow per window; if it still fails when the window ends, the next one follows.</p>
          <label className="flex items-center gap-2 text-[12px] text-t2">
            <Switch checked={Boolean(draft.includeManual)} onChange={(includeManual) => patch({ includeManual })} label="Include editor runs" />
            Count runs started from the editor too
          </label>
        </div>
      )}
      {kind === 'plugin' && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-t2">
            Alert when a plugin has been offline for more than
            <Input value={grace} onChange={(e) => setGrace(e.target.value)} inputMode="numeric" className="h-7 w-20 text-center" aria-label="Grace period in seconds" />
            seconds
          </div>
          <p className="text-[11px] text-t3">A restart announces again within seconds and never alerts. Built-in nodes never go offline.</p>
          <div>
            <div className="mb-1 text-[11px] text-t3">Plugins to watch {pluginIds.length ? '' : '(none picked: all of them)'}</div>
            <div className="flex flex-wrap gap-1.5">
              {plugins.map((plugin) => (
                <button
                  key={plugin.id}
                  type="button"
                  aria-pressed={pluginIds.includes(plugin.id)}
                  onClick={() => setPluginIds(toggle(pluginIds, plugin.id))}
                  className={cn('h-7 rounded-full border px-3 text-[12px] transition-colors', pluginIds.includes(plugin.id) ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
                >
                  {plugin.info.name || plugin.id}
                </button>
              ))}
              {!plugins.length && <span className="text-[12px] text-t3">No external plugin registered right now.</span>}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[12px] text-t2">
            <Switch checked={recovery} onChange={setRecovery} label="Tell me when it is back" />
            Send a message when the plugin is back online
          </label>
        </div>
      )}
      {kind === 'cost' && (
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2 text-[12px] text-t2">
            Alert when usage reaches
            <Input value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="decimal" className="h-7 w-16 text-center" aria-label="Threshold percent" />% of any cap, once per day or month
          </div>
          <p className="text-[11px] text-t3">Caps watched: a workflow’s daily limits (Workflow settings), an agent’s daily and monthly limits, and the caps per credential and per user (Settings → AI prices). The alert goes out before the cap stops runs.</p>
        </div>
      )}
      {kind === 'evaluation' && (
        <div className="space-y-1.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div>
              <FieldLabel>Metric (empty: every metric)</FieldLabel>
              <Input value={score.metric} onChange={(e) => setScore({ ...score, metric: e.target.value })} placeholder="correctness" />
            </div>
            <div>
              <FieldLabel>Average below</FieldLabel>
              <Input value={score.below} onChange={(e) => setScore({ ...score, below: e.target.value })} inputMode="decimal" placeholder="0.8" />
            </div>
            <div>
              <FieldLabel>Or dropped by more than (%)</FieldLabel>
              <Input value={score.dropPercent} onChange={(e) => setScore({ ...score, dropPercent: e.target.value })} inputMode="decimal" placeholder="10" />
            </div>
          </div>
          <p className="text-[11px] text-t3">Checked when an evaluation run finishes: a metric’s average against the minimum, and against the previous finished run of the same workflow. Runs started by hand or by the schedule both count.</p>
        </div>
      )}
      {kind === 'runs' && (
      <div>
        <FieldLabel>Alert when</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {ALERT_EVENTS.map((e) => (
            <button
              key={e.id}
              type="button"
              aria-pressed={draft.events.includes(e.id)}
              title={e.hint}
              onClick={() => patch({ events: toggle(draft.events, e.id) })}
              className={cn('h-7 rounded-full border px-3 text-[12px] transition-colors', draft.events.includes(e.id) ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
            >
              {e.label}
            </button>
          ))}
        </div>
        {draft.events.includes('waiting') && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-t2">
            A run has waited longer than
            <Input value={waiting} onChange={(e) => setWaiting(e.target.value)} inputMode="numeric" className="h-7 w-20 text-center" aria-label="Waiting minutes" />
            minutes (a Wait node’s timer that isn’t due yet doesn’t count)
          </div>
        )}
        <p className="mt-1.5 text-[11px] text-t3">“Failed” covers timeouts and exhausted retries too; a run with an automatic retry still to come never alerts.</p>
      </div>
      )}
      <div>
        <FieldLabel>Send to</FieldLabel>
        <div className="flex flex-wrap gap-1.5">
          {channels.map((c) => {
            const Icon = KIND_ICON[c.kind];
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={draft.channelIds.includes(c.id)}
                onClick={() => patch({ channelIds: toggle(draft.channelIds, c.id) })}
                className={cn('flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors', draft.channelIds.includes(c.id) ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
              >
                <Icon className="size-3" /> {c.name}
              </button>
            );
          })}
          {!channels.length && <span className="text-[12px] text-t3">Add a channel first.</span>}
        </div>
      </div>
      {kind === 'runs' && (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <FieldLabel>How often</FieldLabel>
          <Select value={String(draft.throttleMinutes)} onChange={(e) => patch({ throttleMinutes: Number(e.target.value) })}>
            {THROTTLES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
            {!THROTTLES.some((t) => t.value === draft.throttleMinutes) && <option value={draft.throttleMinutes}>At most one per {draft.throttleMinutes} min</option>}
          </Select>
          <p className="mt-1 text-[11px] text-t3">Per workflow. The alerts held back go out as one digest when the window ends.</p>
        </div>
        <label className="flex items-start gap-2.5 pt-6 text-[12px] text-t2">
          <Switch checked={Boolean(draft.includeManual)} onChange={(includeManual) => patch({ includeManual })} label="Include editor runs" />
          <span>Also alert on runs started from the editor (manual and chat test runs)</span>
        </label>
      </div>
      )}
      {problem && <div className="text-[12px] text-rd">{problem}</div>}
      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={() => void save()} loading={saving}>
          {initial ? 'Save rule' : 'Add rule'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function scopeText(scope: AlertScope, workflows: WorkflowSummary[]): string {
  if (scope.mode === 'ids') {
    const names = (scope.ids ?? []).map((id) => workflows.find((w) => w.id === id)?.name ?? 'deleted workflow');
    return names.length <= 2 ? names.join(', ') || 'No workflow' : `${names.length} workflows`;
  }
  if (scope.mode === 'tags') return `Tagged ${(scope.tags ?? []).join(', ')}`;
  return 'All workflows';
}

/** What a rule watches, in a line. */
function ruleSummary(rule: AlertRule, workflows: WorkflowSummary[]): string {
  switch (rule.kind ?? 'runs') {
    case 'failureRate': {
      const { minRuns, percent, windowMinutes } = { ...DEFAULT_FAILURE_RATE, ...rule.failureRate };
      return `${scopeText(rule.workflows, workflows)} · failure rate > ${percent}% of ≥ ${minRuns} runs in ${windowMinutes} min`;
    }
    case 'plugin':
      return `${rule.plugins?.ids?.length ? `${rule.plugins.ids.length} plugin${rule.plugins.ids.length === 1 ? '' : 's'}` : 'All plugins'} offline > ${rule.plugins?.graceSeconds ?? DEFAULT_PLUGIN_GRACE_SECONDS} s${rule.plugins?.notifyRecovery === false ? '' : ' (and back online)'}`;
    case 'cost':
      return `AI usage at ${rule.cost?.thresholdPercent ?? DEFAULT_COST_THRESHOLD_PERCENT}% of a cap`;
    case 'evaluation': {
      const { metric, below, dropPercent } = rule.evaluation ?? {};
      return `${scopeText(rule.workflows, workflows)} · ${metric || 'any metric'}${below !== undefined ? ` < ${below}` : ''}${dropPercent ? ` or down > ${dropPercent}%` : ''}`;
    }
    default:
      return `${scopeText(rule.workflows, workflows)} · ${rule.events.map((e) => (e === 'waiting' ? `Waiting > ${rule.waitingMinutes ?? DEFAULT_WAITING_MINUTES} min` : EVENT_LABEL[e])).join(', ')}`;
  }
}

export function AlertsSettings() {
  const viewer = useViewer();
  const admin = can(viewer, 'settings:manage');
  const { credentials } = useCredentials();
  const [view, setView] = useState<AlertsView>();
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [error, setError] = useState<string>();
  const [channelEdit, setChannelEdit] = useState<string | 'new' | null>(null);
  const [ruleEdit, setRuleEdit] = useState<string | 'new' | null>(null);
  const [confirm, setConfirm] = useState<string>();
  const [testing, setTesting] = useState<string>();

  useEffect(() => {
    api<AlertsView>('/api/settings/alerts')
      .then(setView)
      .catch((e: Error) => setError(e.message));
    api<{ workflows: WorkflowSummary[] }>('/api/workflows')
      .then(({ workflows: list }) => setWorkflows(list.sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setWorkflows([]));
  }, []);

  const test = async (channel: AlertChannel) => {
    setTesting(channel.id);
    try {
      const { delivery } = await api<{ delivery: AlertDelivery }>(`/api/settings/alerts/channels/${channel.id}/test`, { method: 'POST' });
      if (delivery.ok) toast.success(`Test alert sent to ${channel.name}`);
      else toast.error(`${channel.name}: ${delivery.message}`);
      setView(await api<AlertsView>('/api/settings/alerts'));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(undefined);
    }
  };

  const remove = async (path: string, what: string) => {
    try {
      setView(await api<AlertsView>(path, { method: 'DELETE' }));
      toast.success(`Deleted ${what}`);
      setConfirm(undefined);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const setEnabled = async (rule: AlertRule, enabled: boolean) => {
    try {
      setView(await api<AlertsView>(`/api/settings/alerts/rules/${rule.id}`, { method: 'PATCH', json: { enabled } }));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  if (error) return <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>;
  if (!view) return <div className="text-[13px] text-t3">Loading…</div>;
  const channelName = (id: string) => view.channels.find((c) => c.id === id)?.name;

  return (
    <div className="space-y-6">
      <p className="text-[13px] text-t2">
        Hear about failed runs without building an error workflow: pick where alerts go, then which workflows and events send them. Each alert names the workflow, the failing node and the
        error, and links to the execution. A workflow’s own Settings has a quick <span className="font-semibold text-t1">Notify on failure</span> switch too.
        {!admin && ' Only admins can change alerts.'}
      </p>

      <section className="space-y-2.5">
        <div className="flex items-center gap-3">
          <SectionLabel className="flex-1">Channels</SectionLabel>
          {admin && (
            <Button size="sm" variant="primary" onClick={() => setChannelEdit('new')} disabled={channelEdit === 'new'}>
              <Plus className="size-3.5" /> Add channel
            </Button>
          )}
        </div>
        <Card className="overflow-hidden p-0">
          {channelEdit === 'new' && (
            <ChannelEditor
              emailConfigured={view.email.configured}
              onSaved={(next) => {
                setView(next);
                setChannelEdit(null);
              }}
              onCancel={() => setChannelEdit(null)}
            />
          )}
          {view.channels.map((channel) =>
            channelEdit === channel.id ? (
              <ChannelEditor
                key={channel.id}
                initial={channel}
                emailConfigured={view.email.configured}
                onSaved={(next) => {
                  setView(next);
                  setChannelEdit(null);
                }}
                onCancel={() => setChannelEdit(null)}
              />
            ) : (
              <div key={channel.id} className="flex items-center gap-3 border-b border-hair px-4 py-3 last:border-b-0">
                {(() => {
                  const Icon = KIND_ICON[channel.kind];
                  return (
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-hair bg-wl">
                      <Icon className="size-4 text-t2" />
                    </span>
                  );
                })()}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-t1">{channel.name}</span>
                    <Badge tone="muted">{ALERT_CHANNEL_KINDS.find((k) => k.id === channel.kind)?.label}</Badge>
                    {channel.kind === 'email' && !view.email.configured && (
                      <Badge tone="warning" title="Set LANDFLOW_SMTP_HOST on the host">
                        SMTP not set
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-t3">{channelTarget(channel, credentials?.find((c) => c.id === channel.config.credentialId)?.name)}</div>
                  <div className="text-[11px]">
                    <DeliveryLine delivery={channel.lastDelivery} />
                  </div>
                </div>
                {admin &&
                  (confirm === channel.id ? (
                    <div className="flex items-center gap-1.5 text-[12px] text-t2">
                      Delete?
                      <Button size="sm" variant="danger" onClick={() => void remove(`/api/settings/alerts/channels/${channel.id}`, channel.name)}>
                        Delete
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(undefined)} aria-label="Keep it">
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Button size="sm" onClick={() => void test(channel)} loading={testing === channel.id} title="Send a test alert">
                        <Send className="size-3.5" /> Test
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setChannelEdit(channel.id)} aria-label={`Edit ${channel.name}`}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(channel.id)} aria-label={`Delete ${channel.name}`}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
              </div>
            ),
          )}
          {!view.channels.length && channelEdit !== 'new' && (
            <div className="py-6">
              <EmptyState title="No channels yet" hint="Email, a Slack channel, a webhook or a Telegram chat: where failure alerts go." />
            </div>
          )}
        </Card>
      </section>

      <section className="space-y-2.5">
        <div className="flex items-center gap-3">
          <SectionLabel className="flex-1">Rules</SectionLabel>
          {admin && (
            <Button size="sm" variant="primary" onClick={() => setRuleEdit('new')} disabled={ruleEdit === 'new' || !view.channels.length} title={view.channels.length ? undefined : 'Add a channel first'}>
              <Plus className="size-3.5" /> Add rule
            </Button>
          )}
        </div>
        <Card className="overflow-hidden p-0">
          {ruleEdit === 'new' && (
            <RuleEditor
              channels={view.channels}
              workflows={workflows}
              onSaved={(next) => {
                setView(next);
                setRuleEdit(null);
              }}
              onCancel={() => setRuleEdit(null)}
            />
          )}
          {view.rules.map((rule) =>
            ruleEdit === rule.id ? (
              <RuleEditor
                key={rule.id}
                initial={rule}
                channels={view.channels}
                workflows={workflows}
                onSaved={(next) => {
                  setView(next);
                  setRuleEdit(null);
                }}
                onCancel={() => setRuleEdit(null)}
              />
            ) : (
              <div key={rule.id} className={cn('flex items-center gap-3 border-b border-hair px-4 py-3 last:border-b-0', !rule.enabled && 'opacity-60')}>
                <Switch checked={rule.enabled} onChange={(enabled) => void setEnabled(rule, enabled)} disabled={!admin} label={`${rule.name} on`} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[13px] font-semibold text-t1">{rule.name}</span>
                    {rule.shortcutFor && (
                      <Badge tone="muted" title="Made with Notify on failure in the workflow's settings">
                        workflow setting
                      </Badge>
                    )}
                  </div>
                  <div className="truncate text-[12px] text-t3">
                    {ruleSummary(rule, workflows)} → {rule.channelIds.map((id) => channelName(id) ?? 'deleted channel').join(', ') || 'no channel'}
                    {(rule.kind ?? 'runs') === 'runs' ? ` · ${THROTTLES.find((t) => t.value === rule.throttleMinutes)?.label.toLowerCase() ?? `≤ 1 per ${rule.throttleMinutes} min`}` : ''}
                    {rule.includeManual ? ' · incl. editor runs' : ''}
                  </div>
                </div>
                {admin &&
                  (confirm === rule.id ? (
                    <div className="flex items-center gap-1.5 text-[12px] text-t2">
                      Delete?
                      <Button size="sm" variant="danger" onClick={() => void remove(`/api/settings/alerts/rules/${rule.id}`, rule.name)}>
                        Delete
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(undefined)} aria-label="Keep it">
                        <X className="size-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1">
                      <Button size="icon-sm" variant="ghost" onClick={() => setRuleEdit(rule.id)} aria-label={`Edit ${rule.name}`}>
                        <Pencil className="size-3.5" />
                      </Button>
                      <Button size="icon-sm" variant="ghost" onClick={() => setConfirm(rule.id)} aria-label={`Delete ${rule.name}`}>
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
              </div>
            ),
          )}
          {!view.rules.length && ruleEdit !== 'new' && (
            <div className="py-6">
              <EmptyState
                title="No rules yet"
                hint={view.channels.length ? 'Say which workflows and events send an alert, and how often.' : 'Add a channel, then a rule that sends to it.'}
                action={
                  admin && view.channels.length ? (
                    <Button variant="primary" size="sm" onClick={() => setRuleEdit('new')}>
                      <BellRing className="size-3.5" /> Alert on failed runs
                    </Button>
                  ) : undefined
                }
              />
            </div>
          )}
        </Card>
      </section>
    </div>
  );
}
