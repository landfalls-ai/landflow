'use client';
/**
 * Settings → Workers (read-only): queue mode at a glance. Which main leads (and its fencing token), how many jobs wait
 * and how many workers hold, and every main and worker with a current heartbeat: its runs, what it has processed and
 * when it last checked in. Refreshes every 5 s. In regular mode it says so and how to turn queue mode on.
 */
import { useEffect, useState } from 'react';
import { Cpu, Crown, Inbox, Server } from 'lucide-react';
import { api } from '@/lib/client/api';
import { timeAgo } from '@/lib/client/format';
import type { ClusterInstance, ClusterStatus } from '@/lib/shared/cluster';
import { Card } from '@/components/shell/page-header';
import { Badge } from '@/components/ui/badge';
import { SectionLabel } from '@/components/ui/inputs';

const REFRESH_MS = 5_000;

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-[10px] border border-hair bg-wl px-3 py-2.5">
      <div className="text-[11px] text-t3">{label}</div>
      <div className="mt-0.5 truncate text-[18px] font-semibold tabular-nums text-t1" title={hint}>
        {value}
      </div>
    </div>
  );
}

function InstanceRow({ instance, self }: { instance: ClusterInstance; self: string }) {
  const Icon = instance.role === 'worker' ? Cpu : Server;
  return (
    <tr className="border-t border-hair">
      <td className="py-2 pr-3">
        <div className="flex items-center gap-2">
          <Icon className="size-3.5 shrink-0 text-t3" strokeWidth={1.8} />
          <span className="truncate font-mono text-[12px] text-t1" title={`${instance.hostname} · pid ${instance.pid}`}>
            {instance.id}
          </span>
          {instance.id === self && <Badge tone="muted">this one</Badge>}
        </div>
      </td>
      <td className="py-2 pr-3">
        <div className="flex flex-wrap gap-1">
          <Badge tone={instance.role === 'worker' ? 'accent' : 'neutral'}>{instance.role}</Badge>
          {instance.leader && (
            <Badge tone="success">
              <Crown className="size-3" /> leader
            </Badge>
          )}
          {instance.draining && <Badge tone="warning">stopping</Badge>}
        </div>
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-t1">
        {instance.active}
        {instance.concurrency ? <span className="text-t3"> / {instance.concurrency}</span> : null}
      </td>
      <td className="py-2 pr-3 text-right tabular-nums text-t2">{instance.role === 'worker' ? (instance.processed ?? 0) : (instance.awaiting ?? 0)}</td>
      <td className="py-2 text-right text-t3">{timeAgo(instance.lastSeen)}</td>
    </tr>
  );
}

export function WorkersSettings() {
  const [status, setStatus] = useState<ClusterStatus>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<ClusterStatus>('/api/settings/workers')
        .then((next) => {
          if (!alive) return;
          setStatus(next);
          setError(undefined);
        })
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const timer = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!status) {
    return error ? (
      <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>
    ) : (
      <div className="h-36 rounded-2xl border border-hair bg-sf animate-pulse-soft" />
    );
  }

  if (status.mode === 'regular') {
    return (
      <Card className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <Server className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Regular mode</SectionLabel>
        </div>
        <p className="text-[13px] leading-relaxed text-t2">
          Every execution runs in this process ({status.database === 'postgres' ? 'Postgres' : 'SQLite'}). To spread production runs over worker processes and run
          several mains with failover, start every process with <span className="font-mono text-[12px] text-t1">LANDFLOW_EXECUTIONS_MODE=queue</span>,{' '}
          <span className="font-mono text-[12px] text-t1">LANDFLOW_VALKEY_URL</span> and Postgres, then start workers with{' '}
          <span className="font-mono text-[12px] text-t1">pnpm worker</span>.
        </p>
      </Card>
    );
  }

  const instances = status.instances ?? [];
  const workers = instances.filter((i) => i.role === 'worker');
  const mains = instances.filter((i) => i.role === 'main');
  const capacity = workers.reduce((sum, w) => sum + (w.concurrency ?? 0), 0);
  const leader = status.leader?.holder;

  return (
    <div className="space-y-4">
      <Card className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2">
          <Inbox className="size-4 text-t3" strokeWidth={1.8} />
          <SectionLabel>Queue mode</SectionLabel>
          <span className="ml-auto text-[12px] text-t3">Valkey prefix {status.settings?.prefix}</span>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label="Waiting jobs" value={status.queue?.waiting ?? 0} hint="Jobs no worker took yet" />
          <Stat label="Running on workers" value={status.queue?.active ?? 0} hint="Jobs workers hold now" />
          <Stat label="Workers" value={workers.length} hint={`${capacity} runs at once in all`} />
          <Stat label="Mains" value={mains.length} />
        </div>
        <p className="mt-3 text-[12px] leading-relaxed text-t3">
          {leader ? (
            <>
              <span className="font-mono text-t2">{leader}</span> leads (fencing token {status.leader?.token}): it runs schedules, polls, IMAP IDLE, timers and
              retention. Another main takes over within about {Math.round((status.settings?.leaderTtlSeconds ?? 10) * 1.4)} s if it stops.
            </>
          ) : (
            'No main leads right now: schedules and timers wait until one takes over.'
          )}{' '}
          Editor runs {status.settings?.offloadManual ? 'go to the workers too' : 'run in the main that started them'}; a worker that stops is replaced after{' '}
          {status.settings?.stalledSeconds ?? 30} s and its runs continue from their last checkpoint.
        </p>
      </Card>

      <Card className="px-5 py-4">
        <SectionLabel className="mb-2">Processes</SectionLabel>
        {instances.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[13px]">
              <thead>
                <tr className="text-left text-[11px] text-t3">
                  <th className="pb-1.5 font-medium">Instance</th>
                  <th className="pb-1.5 font-medium">Role</th>
                  <th className="pb-1.5 text-right font-medium">Runs now</th>
                  <th className="pb-1.5 text-right font-medium" title="Workers: jobs processed. Mains: runs waiting for a worker.">
                    Processed / waiting
                  </th>
                  <th className="pb-1.5 text-right font-medium">Last seen</th>
                </tr>
              </thead>
              <tbody>
                {instances.map((instance) => (
                  <InstanceRow key={instance.id} instance={instance} self={status.self.id} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-[13px] text-t3">No heartbeats yet.</p>
        )}
        {!workers.length && (
          <p className="mt-3 rounded-[10px] border border-warnbd bg-warndim px-3 py-2 text-[12px] text-warn">
            No worker is running: production runs wait in the queue. Start one with <span className="font-mono">pnpm worker</span>.
          </p>
        )}
      </Card>
      {error && <div className="rounded-[10px] border border-rdbd bg-rddim px-3 py-2.5 text-[13px] text-rd">{error}</div>}
    </div>
  );
}
