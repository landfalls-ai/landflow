'use client';
/** Insights → Agent layers: how many agent requests the response cache answered and the model router sent to a cheaper model. */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';
import { formatCost } from '@/lib/shared/ai-usage';
import { Card } from '../shell/page-header';
import { SectionLabel } from '../ui/inputs';

interface Stats {
  requests: number;
  routed: number;
  cached: number;
  saved?: { routing: number; cache: number };
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');

export function AgentLayersCard({ days, label }: { days: number; label: string }) {
  const [stats, setStats] = useState<Stats>();
  useEffect(() => {
    setStats(undefined);
    api<{ stats: Stats }>(`/api/insights/agent-layers?days=${days}`)
      .then((r) => setStats(r.stats))
      // Extra: the page works without it.
      .catch(() => setStats(undefined));
  }, [days]);
  // Nothing to show until an agent has been asked something.
  if (!stats?.requests) return null;
  const tiles = [
    { name: 'Agent requests', value: stats.requests.toLocaleString(), note: `in the last ${label}` },
    { name: 'Answered from the cache', value: stats.cached.toLocaleString(), note: `${percent(stats.cached, stats.requests)} of requests, no model call` },
    { name: 'Sent to a cheaper model', value: stats.routed.toLocaleString(), note: `${percent(stats.routed, stats.requests)} of requests, by the model router` },
  ];
  const saved = (stats.saved?.routing ?? 0) + (stats.saved?.cache ?? 0);
  if (saved > 0) tiles.push({ name: 'Estimated saved', value: formatCost(saved), note: `${formatCost(stats.saved?.routing ?? 0)} by routing, ${formatCost(stats.saved?.cache ?? 0)} by the cache` });
  return (
    <Card className="px-4 pb-3 pt-3.5">
      <SectionLabel>Agent layers</SectionLabel>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.name}>
            <div className="text-[12px] text-t3">{tile.name}</div>
            <div className="text-[22px] font-semibold leading-tight text-t1">{tile.value}</div>
            <div className="text-[12px] text-t3">{tile.note}</div>
          </div>
        ))}
      </div>
    </Card>
  );
}
