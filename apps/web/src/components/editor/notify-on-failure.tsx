'use client';
/**
 * The workflow Settings dialog's "Notify on failure": a switch and the alert channels to use, saved right away as an
 * alert rule scoped to this workflow (/api/workflows/[id]/alert). The channels come from Settings → Alerts.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Mail, MessageSquare, Send, Webhook } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/lib/client/api';
import { DEFAULT_THROTTLE_MINUTES, type AlertChannelKind, type WorkflowAlertView } from '@/lib/shared/alerts';
import { Select, Switch } from '../ui/inputs';

const KIND_ICON: Record<AlertChannelKind, typeof Mail> = { email: Mail, slack: MessageSquare, webhook: Webhook, telegram: Send };

export function NotifyOnFailure({ workflowId }: { workflowId?: string }) {
  const [view, setView] = useState<WorkflowAlertView>();
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!workflowId) return;
    api<WorkflowAlertView>(`/api/workflows/${workflowId}/alert`)
      .then((next) => {
        setView(next);
        setPicked(next.rule?.channelIds ?? (next.channels.length === 1 ? [next.channels[0].id] : []));
      })
      .catch(() => setView({ channels: [] }));
  }, [workflowId]);

  const on = Boolean(view?.rule);
  const save = async (channelIds: string[], throttleMinutes = view?.rule?.throttleMinutes ?? DEFAULT_THROTTLE_MINUTES) => {
    if (!workflowId) return;
    setBusy(true);
    try {
      const next = channelIds.length
        ? await api<WorkflowAlertView>(`/api/workflows/${workflowId}/alert`, { method: 'PUT', json: { channelIds, throttleMinutes } })
        : await api<WorkflowAlertView>(`/api/workflows/${workflowId}/alert`, { method: 'DELETE' });
      setView(next);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const toggleChannel = (id: string) => {
    const next = picked.includes(id) ? picked.filter((other) => other !== id) : [...picked, id];
    setPicked(next);
    if (on) void save(next);
  };

  return (
    <div className="rounded-[10px] border border-hair bg-wl px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-semibold text-t1">Notify on failure</div>
          <div className="text-[12px] text-t3">
            {!workflowId
              ? 'Save the workflow first.'
              : view && !view.channels.length
                ? 'No alert channels yet: add one in Settings → Alerts.'
                : 'Email, Slack, webhook or Telegram when a production run fails. Saved right away.'}
          </div>
        </div>
        <Switch
          checked={on}
          disabled={!workflowId || !view?.channels.length || busy || (!on && !picked.length)}
          onChange={(value) => void save(value ? picked : [])}
          label="Notify on failure"
        />
      </div>
      {view && view.channels.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {view.channels.map((channel) => {
            const Icon = KIND_ICON[channel.kind];
            const active = picked.includes(channel.id);
            return (
              <button
                key={channel.id}
                type="button"
                aria-pressed={active}
                disabled={busy}
                onClick={() => toggleChannel(channel.id)}
                className={cn('flex h-7 items-center gap-1.5 rounded-full border px-3 text-[12px] transition-colors', active ? 'border-ac bg-acdim font-semibold text-t1' : 'border-hair text-t2 hover:border-ac hover:text-ac')}
              >
                <Icon className="size-3" /> {channel.name}
              </button>
            );
          })}
          {on && (
            <div className="ml-auto w-48">
              <Select
                value={String(view.rule?.throttleMinutes ?? DEFAULT_THROTTLE_MINUTES)}
                onChange={(e) => void save(picked, Number(e.target.value))}
                disabled={busy}
                aria-label="How often"
                className="h-7 text-[12px]"
              >
                <option value="0">Every failure</option>
                <option value="10">At most one per 10 min</option>
                <option value="60">At most one per hour</option>
                <option value="1440">At most one per day</option>
                {![0, 10, 60, 1440].includes(view.rule?.throttleMinutes ?? DEFAULT_THROTTLE_MINUTES) && (
                  <option value={view.rule?.throttleMinutes}>At most one per {view.rule?.throttleMinutes} min</option>
                )}
              </Select>
            </div>
          )}
        </div>
      )}
      {view && !view.channels.length && workflowId && (
        <Link href="/settings#alerts" className="mt-1 inline-block text-[12px] text-t2 underline-offset-2 hover:text-ac hover:underline">
          Open Settings → Alerts
        </Link>
      )}
    </div>
  );
}
