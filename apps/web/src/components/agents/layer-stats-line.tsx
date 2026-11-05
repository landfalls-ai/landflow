'use client';
/** One line under the router and cache cards: how many of the agent's recent requests each one handled. */
import { useEffect, useState } from 'react';
import { api } from '@/lib/client/api';

interface Stats {
  sessions: number;
  requests: number;
  routed: number;
  cached: number;
}

const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '0%');

export function LayerStatsLine({ agentId, kind }: { agentId: string; kind: 'routed' | 'cached' }) {
  const [stats, setStats] = useState<Stats>();
  useEffect(() => {
    api<{ stats: Stats }>(`/api/agents/${agentId}/layer-stats`)
      .then((r) => setStats(r.stats))
      .catch(() => setStats(undefined));
  }, [agentId]);
  if (!stats || !stats.requests) return null;
  const count = stats[kind];
  const what = kind === 'routed' ? 'went to the cheaper model' : 'were answered from the cache';
  return (
    <p className="text-[12px] text-t3">
      Of the last {stats.requests} request{stats.requests === 1 ? '' : 's'}, {count} ({percent(count, stats.requests)}) {what}.
    </p>
  );
}
