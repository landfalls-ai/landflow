'use client';
/** Build tab → Triggers: schedules that message the agent, and chat channels it answers in (Telegram, Slack). */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { Clock, Hash, Info, Pencil, Plus, Send, Trash2, X, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AgentChannel, AgentConfig, AgentSchedule, ScheduleFrequency } from '@/lib/shared/agents';
import { CredentialDialog } from '../credentials/credential-dialog';
import { useCredentials } from '../credentials/use-credentials';
import { Badge, Chip } from '../ui/badge';
import { Button } from '../ui/button';
import { CopyButton } from '../ui/copy-button';
import { Input, Select, Switch, Textarea } from '../ui/inputs';
import { Dialog, Field, ItemRow, Section, ToggleRow } from './dialog';
import { describeSchedule, localTimezone, newId, timezones, WEEKDAYS, type UpdateConfig } from './util';

const TELEGRAM = 'messaging.telegramApi';
const SLACK = 'messaging.slackApi';
const CREATE = '__create__';

type ChannelType = AgentChannel['type'];

/** What differs between the channel types in the dialog and the list. */
const CHANNEL_TEXT: Record<ChannelType, { name: string; subtitle: string; bot: string; noCredential: string; publicHint: string; usersHint: string; usersMissing: string; placeholder: string }> = {
  telegram: {
    name: 'Telegram',
    subtitle: 'The published agent answers messages sent to your Telegram bot.',
    bot: 'Telegram bot',
    noCredential: 'Create a Telegram API credential with your bot token from @BotFather.',
    publicHint: 'Anyone who finds the bot',
    usersHint: 'Telegram usernames or numeric user ids.',
    usersMissing: 'Add at least one Telegram username or user id.',
    placeholder: '@username or user id, then Enter',
  },
  slack: {
    name: 'Slack',
    subtitle: 'The published agent answers when it is mentioned in a channel or sent a direct message, in the message’s thread.',
    bot: 'Slack app',
    noCredential: 'Create a Slack API credential with the bot token (xoxb-…) and the app’s Signing Secret.',
    publicHint: 'Anyone in the workspace who can reach the app',
    usersHint: 'Slack member ids (U…, from a profile’s “Copy member ID”).',
    usersMissing: 'Add at least one Slack member id.',
    placeholder: 'Member id (U0123ABC), then Enter',
  },
};

/** The two URLs a Slack app needs (Event Subscriptions and Interactivity). */
function SlackUrls({ agentId, channelId }: { agentId: string; channelId: string }) {
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const row = (label: string, url: string, hint: string) => (
    <div>
      <div className="text-[12px] font-semibold text-t2">{label}</div>
      <div className="mt-1 flex items-center gap-1 rounded-[10px] border border-hair bg-wl py-1 pl-2.5 pr-1">
        <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-t1" title={url}>
          {url}
        </code>
        <CopyButton text={url} label={`Copy ${label}`} />
      </div>
      <p className="mt-1 text-[12px] leading-snug text-t3">{hint}</p>
    </div>
  );
  return (
    <div className="space-y-3 rounded-xl border border-hair bg-sf2 px-3 py-3">
      {row('Event Subscriptions → Request URL', `${origin}/api/slack/events/${agentId}/${channelId}`, 'Subscribe to the bot events app_mention and message.im.')}
      {row('Interactivity → Request URL', `${origin}/api/slack/interactions`, 'For the Approve / Reject buttons of tools that need approval.')}
      <p className="flex items-start gap-1.5 text-[12px] leading-snug text-t3">
        <Info className="mt-0.5 size-3 shrink-0" />
        Slack checks the Request URL right away: save and publish the agent first. Landflow verifies every request with the credential’s Signing Secret and refuses
        requests without one. Bot scopes: app_mentions:read, chat:write, im:history.
      </p>
    </div>
  );
}

const FREQUENCIES: Array<{ value: ScheduleFrequency; label: string }> = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'cron', label: 'Custom (cron)' },
];

function ScheduleDialog({ schedule, onSave, onClose }: { schedule?: AgentSchedule; onSave: (s: AgentSchedule) => void; onClose: () => void }) {
  const [value, setValue] = useState<AgentSchedule>(
    schedule ?? {
      id: newId('sched'),
      prompt: '',
      frequency: 'daily',
      time: '09:00',
      weekday: 1,
      dayOfMonth: 1,
      timezone: localTimezone(),
      enabled: true,
    },
  );
  const zones = useMemo(() => {
    const all = timezones();
    return all.includes(value.timezone) ? all : [value.timezone, ...all];
  }, [value.timezone]);
  const set = (patch: Partial<AgentSchedule>) => setValue((v) => ({ ...v, ...patch }));
  const cronOk = value.frequency !== 'cron' || /^\S+(\s+\S+){4}$/.test((value.cron ?? '').trim());
  const valid = value.prompt.trim() && cronOk;

  /** Only the fields the frequency uses are kept. */
  const clean = (s: AgentSchedule): AgentSchedule => {
    const { time, weekday, dayOfMonth, cron, ...base } = s;
    switch (s.frequency) {
      case 'hourly':
        return {
          ...base,
          time: String(Math.min(59, Math.max(0, Number(time) || 0))),
        };
      case 'daily':
        return { ...base, time: time || '09:00' };
      case 'weekly':
        return { ...base, time: time || '09:00', weekday: weekday ?? 1 };
      case 'monthly':
        return {
          ...base,
          time: time || '09:00',
          dayOfMonth: Math.min(28, Math.max(1, dayOfMonth ?? 1)),
        };
      case 'cron':
        return { ...base, cron: (cron ?? '').trim() };
    }
  };

  const changeFrequency = (frequency: ScheduleFrequency) =>
    setValue((v) => ({
      ...v,
      frequency,
      time: frequency === 'hourly' ? '0' : v.frequency === 'hourly' || !v.time ? '09:00' : v.time,
    }));

  return (
    <Dialog
      title={schedule ? 'Edit schedule' : 'Add schedule'}
      subtitle="Sends the agent a message on a schedule."
      icon={
        <span className="grid size-8 place-items-center rounded-[10px] border border-hair bg-wl text-t2">
          <Clock className="size-4" />
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" disabled={!valid} onClick={() => onSave(clean({ ...value, prompt: value.prompt.trim() }))}>
            {schedule ? 'Save schedule' : 'Add schedule'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="schedule-prompt" label="What to do" required hint="Sent to the agent as the message of each run.">
          <Textarea
            id="schedule-prompt"
            rows={3}
            value={value.prompt}
            onChange={(e) => set({ prompt: e.target.value })}
            placeholder="Post a summary of yesterday’s new tickets."
            autoFocus
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id="schedule-frequency" label="Frequency">
            <Select id="schedule-frequency" value={value.frequency} onChange={(e) => changeFrequency(e.target.value as ScheduleFrequency)}>
              {FREQUENCIES.map((f) => (
                <option key={f.value} value={f.value}>
                  {f.label}
                </option>
              ))}
            </Select>
          </Field>
          {value.frequency === 'hourly' && (
            <Field id="schedule-minute" label="Minute past the hour">
              <Input id="schedule-minute" type="number" min={0} max={59} value={value.time ?? '0'} onChange={(e) => set({ time: e.target.value })} />
            </Field>
          )}
          {value.frequency === 'weekly' && (
            <Field id="schedule-weekday" label="Day">
              <Select id="schedule-weekday" value={value.weekday ?? 1} onChange={(e) => set({ weekday: Number(e.target.value) })}>
                {WEEKDAYS.map((day, i) => (
                  <option key={day} value={i}>
                    {day}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          {value.frequency === 'monthly' && (
            <Field id="schedule-day" label="Day of month" hint="1–28, so it runs every month.">
              <Input
                id="schedule-day"
                type="number"
                min={1}
                max={28}
                value={value.dayOfMonth ?? 1}
                onChange={(e) => set({ dayOfMonth: Number(e.target.value) })}
              />
            </Field>
          )}
          {(value.frequency === 'daily' || value.frequency === 'weekly' || value.frequency === 'monthly') && (
            <Field id="schedule-time" label="Time">
              <Input id="schedule-time" type="time" value={value.time ?? '09:00'} onChange={(e) => set({ time: e.target.value })} />
            </Field>
          )}
          {value.frequency === 'cron' && (
            <Field
              id="schedule-cron"
              label="Cron expression"
              required
              hint={cronOk ? 'Five fields: minute hour day-of-month month weekday.' : <span className="text-rd">Needs five fields, e.g. 0 9 * * 1-5</span>}
            >
              <Input
                id="schedule-cron"
                value={value.cron ?? ''}
                onChange={(e) => set({ cron: e.target.value })}
                placeholder="0 9 * * 1-5"
                className="font-mono"
              />
            </Field>
          )}
          <Field id="schedule-timezone" label="Timezone" className={value.frequency === 'weekly' || value.frequency === 'monthly' ? '' : 'sm:col-span-2'}>
            <Select id="schedule-timezone" value={value.timezone} onChange={(e) => set({ timezone: e.target.value })}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {zone}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <ToggleRow title="Enabled" description="Paused schedules keep their settings." checked={value.enabled} onChange={(enabled) => set({ enabled })} />
      </div>
    </Dialog>
  );
}

function UsersInput({ id, value, onChange, placeholder = '@username or user id, then Enter' }: { id: string; value: string[]; onChange: (users: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState('');
  const add = () => {
    const users = text
      .split(/[\s,]+/)
      .map((u) => u.trim())
      .filter((u) => u && !value.includes(u));
    if (users.length) onChange([...value, ...users]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add();
    } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-[10px] border border-hair bg-wl px-2 py-1.5 focus-within:border-ac">
      {value.map((user) => (
        <Chip key={user} mono>
          {user}
          <button
            type="button"
            aria-label={`Remove ${user}`}
            onClick={() => onChange(value.filter((u) => u !== user))}
            className="-mr-1 grid size-4 place-items-center rounded-full text-t3 hover:text-rd"
          >
            <X className="size-3" />
          </button>
        </Chip>
      ))}
      <input
        id={id}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={add}
        placeholder={value.length ? '' : placeholder}
        className="min-w-[140px] flex-1 bg-transparent px-1 text-[13px] text-t1 outline-none placeholder:text-t3"
      />
    </div>
  );
}

function ChannelDialog({
  channel,
  type: newType = 'telegram',
  agentId,
  onSave,
  onClose,
}: {
  channel?: AgentChannel;
  type?: ChannelType;
  agentId?: string;
  onSave: (c: AgentChannel) => void;
  onClose: () => void;
}) {
  const type = channel?.type ?? newType;
  const text = CHANNEL_TEXT[type];
  const credentialType = type === 'slack' ? SLACK : TELEGRAM;
  const { credentials } = useCredentials();
  const options = (credentials ?? []).filter((c) => c.type === credentialType);
  const [value, setValue] = useState<
    Omit<AgentChannel, 'credential'> & {
      credential?: AgentChannel['credential'];
    }
  >(
    channel ?? {
      id: newId('chan'),
      type,
      access: 'private',
      allowedUsers: [],
      // Slack threads are sessions of their own.
      newSessionAfterMinutes: type === 'slack' ? 0 : 60,
      enabled: true,
      ...(type === 'slack' && { threadReplies: true }),
    },
  );
  const [creating, setCreating] = useState(false);
  const set = (patch: Partial<typeof value>) => setValue((v) => ({ ...v, ...patch }));
  const credential = value.credential ?? (options.length === 1 ? { id: options[0].id, name: options[0].name } : undefined);
  const valid = credential && (value.access === 'public' || value.allowedUsers.length > 0);

  return (
    <Dialog
      title={`${channel ? 'Edit' : 'Add'} ${text.name} channel`}
      subtitle={text.subtitle}
      icon={
        <span className="grid size-8 place-items-center rounded-[10px] border border-hair bg-wl text-t2">
          {type === 'slack' ? <Hash className="size-4" /> : <Send className="size-4" />}
        </span>
      }
      onClose={onClose}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!valid}
            onClick={() =>
              credential &&
              onSave({
                ...value,
                credential,
                newSessionAfterMinutes: Math.max(0, Math.round(value.newSessionAfterMinutes || 0)),
              })
            }
          >
            {channel ? 'Save channel' : 'Add channel'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id="channel-credential" label={text.bot} required hint={!options.length ? text.noCredential : undefined}>
          <Select
            id="channel-credential"
            value={credential?.id ?? ''}
            onChange={(e) => {
              if (e.target.value === CREATE) return setCreating(true);
              const picked = options.find((c) => c.id === e.target.value);
              set({
                credential: picked && { id: picked.id, name: picked.name },
              });
            }}
          >
            <option value="">{options.length ? 'Select a credential…' : 'No credential yet'}</option>
            {options.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option value={CREATE}>+ Create credential</option>
          </Select>
        </Field>
        <div>
          <div className="mb-[5px] text-[12px] font-semibold text-t2" id="channel-access-label">
            Who can talk to the agent
          </div>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-labelledby="channel-access-label">
            {(
              [
                {
                  value: 'private',
                  title: 'Private',
                  description: 'Only the users listed below',
                },
                {
                  value: 'public',
                  title: 'Public',
                  description: text.publicHint,
                },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={value.access === option.value}
                onClick={() => set({ access: option.value })}
                className={cn(
                  'rounded-xl border px-3 py-2 text-left transition-colors',
                  value.access === option.value ? 'border-ac bg-acdim' : 'border-hair bg-wl hover:border-bd',
                )}
              >
                <div className="text-[13px] font-semibold text-t1">{option.title}</div>
                <div className="text-[12px] text-t3">{option.description}</div>
              </button>
            ))}
          </div>
        </div>
        <Field
          id="channel-users"
          label="Allowed users"
          required={value.access === 'private'}
          hint={
            value.access === 'private' && !value.allowedUsers.length ? <span className="text-warn">{text.usersMissing}</span> : text.usersHint
          }
        >
          <UsersInput id="channel-users" value={value.allowedUsers} onChange={(allowedUsers) => set({ allowedUsers })} placeholder={text.placeholder} />
        </Field>
        <Field
          id="channel-idle"
          label="Start a new session after"
          hint={
            type === 'slack'
              ? 'Each thread is a session. With “Reply in thread” off, minutes without messages before a channel’s conversation starts fresh; 0 never.'
              : 'Minutes without messages before the conversation starts fresh. 0 keeps one session forever.'
          }
        >
          <div className="flex items-center gap-2">
            <Input
              id="channel-idle"
              type="number"
              min={0}
              className="w-28"
              value={value.newSessionAfterMinutes}
              onChange={(e) => set({ newSessionAfterMinutes: Number(e.target.value) })}
            />
            <span className="text-[13px] text-t2">idle minutes</span>
          </div>
        </Field>
        {type === 'slack' && (
          <ToggleRow
            title="Reply in thread"
            description="Answer under the message that asked (each thread is its own session); off: answer in the channel."
            checked={value.threadReplies !== false}
            onChange={(threadReplies) => set({ threadReplies })}
          />
        )}
        <ToggleRow title="Enabled" description="A disabled channel ignores new messages." checked={value.enabled} onChange={(enabled) => set({ enabled })} />
        {type === 'slack' && agentId && <SlackUrls agentId={agentId} channelId={value.id} />}
      </div>
      {creating && (
        <CredentialDialog allowedTypes={[credentialType]} onClose={() => setCreating(false)} onSaved={(c) => set({ credential: { id: c.id, name: c.name } })} />
      )}
    </Dialog>
  );
}

export function TriggersCard({ config, update, published, agentId }: { config: AgentConfig; update: UpdateConfig; published: boolean; agentId?: string }) {
  const [schedule, setSchedule] = useState<{ schedule?: AgentSchedule } | null>(null);
  const [channel, setChannel] = useState<{ channel?: AgentChannel; type?: ChannelType } | null>(null);

  const upsert = <K extends 'schedules' | 'channels'>(key: K, item: AgentConfig[K][number]) =>
    update((c) => {
      const list = c[key] as Array<{ id: string }>;
      return {
        ...c,
        [key]: list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item],
      };
    });
  const remove = (key: 'schedules' | 'channels', id: string) =>
    update((c) => ({
      ...c,
      [key]: (c[key] as Array<{ id: string }>).filter((x) => x.id !== id),
    }));
  const toggle = (key: 'schedules' | 'channels', id: string, enabled: boolean) =>
    update((c) => ({
      ...c,
      [key]: (c[key] as Array<{ id: string; enabled: boolean }>).map((x) => (x.id === id ? { ...x, enabled } : x)),
    }));

  const empty = !config.schedules.length && !config.channels.length;

  return (
    <Section
      icon={<Zap className="size-4" />}
      title="Triggers"
      description="Run the agent on a schedule or let people message it."
      actions={
        <>
          <Button size="sm" variant="outline" onClick={() => setSchedule({})}>
            <Clock className="size-3.5" /> Add schedule
          </Button>
          <Button size="sm" variant="outline" onClick={() => setChannel({ type: 'telegram' })}>
            <Send className="size-3.5" /> Add Telegram
          </Button>
          <Button size="sm" variant="outline" onClick={() => setChannel({ type: 'slack' })}>
            <Hash className="size-3.5" /> Add Slack
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className={cn('flex items-start gap-1.5 text-[12px]', !published && !empty ? 'text-warn' : 'text-t3')}>
          <Info className="mt-0.5 size-3 shrink-0" />
          {published
            ? 'Triggers run the published version. Publish again to apply draft changes.'
            : 'Triggers run only for the published version. Publish the agent to turn them on.'}
        </p>
        {config.schedules.map((s) => (
          <ItemRow
            key={s.id}
            icon={
              <span className="grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-sf text-t2">
                <Clock className="size-3.5" />
              </span>
            }
            title={s.prompt}
            subtitle={`${describeSchedule(s)} · ${s.timezone}`}
            badges={!s.enabled ? <Badge tone="muted">Paused</Badge> : undefined}
            onClick={() => setSchedule({ schedule: s })}
            actions={
              <>
                <Switch checked={s.enabled} onChange={(v) => toggle('schedules', s.id, v)} label={s.enabled ? 'Pause schedule' : 'Enable schedule'} />
                <Button size="icon-sm" variant="ghost" aria-label="Edit schedule" title="Edit" className="ml-1" onClick={() => setSchedule({ schedule: s })}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete schedule"
                  title="Delete"
                  className="hover:bg-rddim hover:text-rd"
                  onClick={() => remove('schedules', s.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            }
          />
        ))}
        {config.channels.map((ch) => (
          <ItemRow
            key={ch.id}
            icon={
              <span className={cn('grid size-8 shrink-0 place-items-center rounded-[10px] border border-hair bg-sf', ch.type === 'slack' ? 'text-[#E01E5A]' : 'text-[#229ED9]')}>
                {ch.type === 'slack' ? <Hash className="size-3.5" /> : <Send className="size-3.5" />}
              </span>
            }
            title={`${CHANNEL_TEXT[ch.type]?.name ?? ch.type} · ${ch.credential.name}`}
            subtitle={`${ch.access === 'private' ? `Private, ${ch.allowedUsers.length} ${ch.allowedUsers.length === 1 ? 'user' : 'users'}` : 'Public'} · ${
              ch.type === 'slack' && ch.threadReplies !== false
                ? 'a session per thread'
                : ch.newSessionAfterMinutes
                  ? `new session after ${ch.newSessionAfterMinutes} idle min`
                  : 'one session per chat'
            }`}
            badges={!ch.enabled ? <Badge tone="muted">Off</Badge> : undefined}
            onClick={() => setChannel({ channel: ch })}
            actions={
              <>
                <Switch checked={ch.enabled} onChange={(v) => toggle('channels', ch.id, v)} label={ch.enabled ? 'Turn channel off' : 'Turn channel on'} />
                <Button size="icon-sm" variant="ghost" aria-label="Edit channel" title="Edit" className="ml-1" onClick={() => setChannel({ channel: ch })}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Delete channel"
                  title="Delete"
                  className="hover:bg-rddim hover:text-rd"
                  onClick={() => remove('channels', ch.id)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </>
            }
          />
        ))}
        {empty && (
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => setSchedule({})}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-bd py-2.5 text-[12px] text-t2 transition-colors hover:border-ac hover:text-ac"
            >
              <Plus className="size-3.5" /> Run on a schedule
            </button>
            <button
              onClick={() => setChannel({ type: 'telegram' })}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-bd py-2.5 text-[12px] text-t2 transition-colors hover:border-ac hover:text-ac"
            >
              <Plus className="size-3.5" /> Chat on Telegram
            </button>
            <button
              onClick={() => setChannel({ type: 'slack' })}
              className="flex flex-1 items-center justify-center gap-1.5 rounded-[10px] border border-dashed border-bd py-2.5 text-[12px] text-t2 transition-colors hover:border-ac hover:text-ac"
            >
              <Plus className="size-3.5" /> Chat in Slack
            </button>
          </div>
        )}
      </div>
      {schedule && (
        <ScheduleDialog
          schedule={schedule.schedule}
          onClose={() => setSchedule(null)}
          onSave={(s) => {
            upsert('schedules', s);
            setSchedule(null);
          }}
        />
      )}
      {channel && (
        <ChannelDialog
          channel={channel.channel}
          type={channel.type}
          agentId={agentId}
          onClose={() => setChannel(null)}
          onSave={(c) => {
            upsert('channels', c);
            setChannel(null);
          }}
        />
      )}
    </Section>
  );
}
